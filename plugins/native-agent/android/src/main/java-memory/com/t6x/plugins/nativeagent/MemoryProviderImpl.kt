package com.t6x.plugins.nativeagent

import android.content.Context
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import uniffi.lancedb_ffi.HybridSearchResult
import uniffi.lancedb_ffi.SearchResult
import uniffi.native_agent_ffi.MemoryProvider

class MemoryProviderImpl(private val context: Context) : MemoryProvider {
    fun isAvailable(): Boolean = LanceDBBridge.getOrCreateHandle(context) != null

    // UniFFI methods on LanceDbHandle are suspend → require runBlocking. The
    // MemoryProvider callback is invoked by Rust on a JNA-managed native
    // thread; running coroutines (and uniffiRustCallAsync's own JNA callbacks)
    // on that thread races with JNA's thread-detach logic, producing
    // SIGABRT "attempting to detach while still running code" on Android ART.
    // Hop to a dedicated JVM-owned worker thread so the JNA callback thread
    // only blocks on Future.get(), never executes coroutine continuations.
    private fun <T> onWorker(block: () -> T): T = WORKER.submit(block).get()

    override fun store(key: String, text: String, metadataJson: String?): String {
        val handle = LanceDBBridge.getOrCreateHandle(context) ?: return unavailableJson()
        val resolvedKey = key.ifBlank {
            "mem-${System.currentTimeMillis()}-${UUID.randomUUID().toString().take(8)}"
        }
        val embedding = localHashEmbed(text, LanceDBBridge.EMBEDDING_DIM)
        return runCatching {
            onWorker {
                runBlocking {
                    handle.store(resolvedKey, DEFAULT_AGENT_ID, text, embedding, metadataJson)
                }
            }
            JSONObject()
                .put("success", true)
                .put("key", resolvedKey)
                .toString()
        }.getOrElse { errorJson(it) }
    }

    override fun recall(query: String, limit: UInt): String {
        val handle = LanceDBBridge.getOrCreateHandle(context) ?: return unavailableJson()
        val embedding = localHashEmbed(query, LanceDBBridge.EMBEDDING_DIM)
        return runCatching {
            val results = onWorker {
                runBlocking {
                    handle.hybridSearch(
                        embedding,
                        query,
                        limit,
                        "agent_id = '$DEFAULT_AGENT_ID'",
                        null,
                        null,
                    )
                }
            }
            hybridResultsJson(results)
        }.getOrElse { errorJson(it) }
    }

    override fun forget(key: String): String {
        val handle = LanceDBBridge.getOrCreateHandle(context) ?: return unavailableJson()
        if (key.isBlank()) {
            return JSONObject().put("error", "Provide query or key.").toString()
        }
        return runCatching {
            onWorker {
                runBlocking {
                    handle.delete(key)
                }
            }
            JSONObject()
                .put("success", true)
                .put("key", key)
                .toString()
        }.getOrElse { errorJson(it) }
    }

    override fun search(query: String, maxResults: UInt): String {
        val handle = LanceDBBridge.getOrCreateHandle(context) ?: return unavailableJson()
        val embedding = localHashEmbed(query, LanceDBBridge.EMBEDDING_DIM)
        return runCatching {
            val results = onWorker {
                runBlocking {
                    handle.search(embedding, maxResults, "agent_id = '$DEFAULT_AGENT_ID'")
                }
            }
            searchResultsJson(results)
        }.getOrElse { errorJson(it) }
    }

    override fun list(prefix: String?, limit: UInt?): String {
        val handle = LanceDBBridge.getOrCreateHandle(context) ?: return unavailableJson()
        return runCatching {
            val keys = onWorker {
                runBlocking {
                    handle.list(prefix, limit)
                }
            }
            JSONArray(keys).toString()
        }.getOrElse { errorJson(it) }
    }

    private fun hybridResultsJson(results: List<HybridSearchResult>): String {
        val array = JSONArray()
        results.forEach { result ->
            array.put(
                JSONObject()
                    .put("key", result.key)
                    .put("text", result.text)
                    .put("vectorRank", result.vectorRank.toInt())
                    .put("textRank", result.textRank.toInt())
                    .put("rrfScore", result.rrfScore)
                    .apply {
                        result.metadata?.let { put("metadata", it) }
                    }
            )
        }
        return array.toString()
    }

    private fun searchResultsJson(results: List<SearchResult>): String {
        val array = JSONArray()
        results.forEach { result ->
            array.put(
                JSONObject()
                    .put("key", result.key)
                    .put("text", result.text)
                    .put("score", result.score)
                    .apply {
                        result.metadata?.let { put("metadata", it) }
                    }
            )
        }
        return array.toString()
    }

    private fun unavailableJson(): String {
        return JSONObject().put("error", "Memory provider not configured").toString()
    }

    private fun errorJson(error: Throwable): String {
        return JSONObject()
            .put("error", error.message ?: error::class.java.simpleName)
            .toString()
    }

    private companion object {
        private const val DEFAULT_AGENT_ID = "main"
        private val WORKER = Executors.newSingleThreadExecutor { r ->
            Thread(r, "memory-provider-worker").apply { isDaemon = true }
        }
        private val WHITESPACE = Regex("\\s+")
        private val UINT_MAX_DOUBLE = 0xffffffffu.toDouble()
        private const val FNV_OFFSET = 0x811c9dc5u
        private const val FNV_PRIME = 0x01000193u
        private const val GOLDEN_RATIO = 2654435761u
        private const val MIX = 0x45d9f3bu

        private fun fnv1a(text: String): UInt {
            var hash = FNV_OFFSET
            text.forEach { char ->
                hash = hash xor char.code.toUInt()
                hash *= FNV_PRIME
            }
            return hash
        }

        private fun seededRandom(seed: UInt, dim: Int): Float {
            var h = seed xor (dim.toUInt() * GOLDEN_RATIO)
            h = (((h shr 16) xor h) * MIX)
            h = (((h shr 16) xor h) * MIX)
            h = (h shr 16) xor h
            return (((h.toDouble() / UINT_MAX_DOUBLE) * 2.0) - 1.0).toFloat()
        }

        private fun localHashEmbed(text: String, dim: Int): List<Float> {
            val tokens = text.lowercase(Locale.ROOT).split(WHITESPACE).filter { it.isNotBlank() }
            val vector = DoubleArray(dim)
            tokens.forEach { token ->
                val hash = fnv1a(token)
                for (index in 0 until dim) {
                    vector[index] += seededRandom(hash, index).toDouble()
                }
            }

            var norm = 0.0
            for (value in vector) {
                norm += value * value
            }
            norm = kotlin.math.sqrt(norm).takeIf { it > 0.0 } ?: 1.0

            return List(dim) { index -> (vector[index] / norm).toFloat() }
        }
    }
}
