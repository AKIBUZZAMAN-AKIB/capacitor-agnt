package com.t6x.plugins.nativeagent

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import kotlin.math.floor

/** Validated, atomic storage for app-owned agent runtime settings. */
internal object AgentRuntimeConfigStore {
    private const val FILE_NAME = ".native-agent-runtime.json"
    private const val MAX_CONFIG_BYTES = 32 * 1024
    private const val PREFS_FILE = NativeWakeStore.CAPACITOR_STORAGE_FILE
    private const val CONFIG_PATH_KEY = NativeWakeStore.CONFIG_PATH_KEY

    private val providers = setOf(
        "anthropic", "openai", "gemini", "openrouter", "ovhcloud", "aihorde",
        "llm7", "opencode_zen", "kilo", "pollinations", "webllm",
    )
    private val stringMapFields = setOf("defaultModels", "providerBaseUrls")
    private val modelMapFields = setOf(
        "providerModelProtocols", "providerToolCapabilities",
        "providerModelAuthRequirements", "providerModelStreamingCapabilities",
    )
    private val routingFields = setOf("providerOrder", "failoverOnTransient", "maxFallbacks")
    private val allowedFields = setOf(
        "temperature", "maxTokens", "defaultMaxTurns", "contextCharBudget",
        "mcpToolTimeoutMs", "maxRetries", "baseRetryDelayMs", "maxRetryDelayMs",
        "defaultCronMaxTurns", "defaultHeartbeatMaxTurns", "defaultCronTimeoutMs",
        "defaultHeartbeatTimeoutMs", "defaultProvider", "defaultModels", "providerBaseUrls",
        "providerModelProtocols", "providerToolCapabilities",
        "providerModelAuthRequirements", "providerModelStreamingCapabilities", "autoRouting",
    )
    // `auto` is deliberately a free-only router: Kilo's live Free router runs
    // first, then OpenRouter's live Free Models Router.
    private val defaultProviderOrder = listOf("kilo", "openrouter")

    fun get(context: Context): JSONObject {
        val file = runtimeFile(context)
        if (!file.isFile) return defaults()
        return try {
            validate(JSONObject(file.readText(Charsets.UTF_8)))
        } catch (error: Throwable) {
            if (error is OutOfMemoryError) throw error
            android.util.Log.w("NativeAgentConfig", "Invalid runtime config; using defaults", error)
            defaults()
        }
    }

    fun update(context: Context, configJson: String): JSONObject {
        require(configJson.toByteArray(Charsets.UTF_8).size <= MAX_CONFIG_BYTES) {
            "Runtime config patch exceeds $MAX_CONFIG_BYTES bytes"
        }
        val patch = JSONObject(configJson)
        val keys = patch.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            require(key in allowedFields) { "Unknown runtime config field '$key'" }
        }

        val merged = get(context)
        val patchKeys = patch.keys()
        while (patchKeys.hasNext()) {
            val key = patchKeys.next()
            when {
                key in stringMapFields -> mergeStringMapPatch(merged, key, patch.get(key))
                key in modelMapFields -> mergeModelMapPatch(merged, key, patch.get(key))
                key == "autoRouting" -> {
                    val raw = patch.get(key)
                    require(raw is JSONObject) { "autoRouting must be an object" }
                    val target = merged.optJSONObject(key) ?: JSONObject()
                    val rawKeys = raw.keys()
                    while (rawKeys.hasNext()) {
                        val field = rawKeys.next()
                        require(field in routingFields) { "Unknown autoRouting field '$field'" }
                        require(raw.get(field) !== JSONObject.NULL) { "autoRouting.$field cannot be null" }
                        target.put(field, raw.get(field))
                    }
                    merged.put(key, target)
                }
                else -> {
                    require(patch.get(key) !== JSONObject.NULL) { "$key cannot be null" }
                    merged.put(key, patch.get(key))
                }
            }
        }

        val normalized = validate(merged)
        writeAtomic(runtimeFile(context), normalized.toString().toByteArray(Charsets.UTF_8))
        return normalized
    }

    private fun mergeStringMapPatch(target: JSONObject, field: String, raw: Any) {
        if (raw === JSONObject.NULL) {
            target.put(field, JSONObject())
            return
        }
        require(raw is JSONObject) { "$field must be an object or null" }
        val values = target.optJSONObject(field) ?: JSONObject()
        val keys = raw.keys()
        while (keys.hasNext()) {
            val provider = keys.next()
            require(provider in providers) { "Unsupported $field key '$provider'" }
            val value = raw.get(provider)
            if (value === JSONObject.NULL) {
                values.remove(provider)
            } else if (field == "providerBaseUrls") {
                require(provider != "webllm") { "providerBaseUrls.webllm is not valid for a local browser runtime" }
                require(value is String) { "$field.$provider must be a URL string or null" }
                values.put(provider, validateProviderUrl(provider, value))
            } else {
                require(value is String && value.trim().isNotEmpty() && value.trim().toByteArray(Charsets.UTF_8).size <= 512) {
                    "$field.$provider must contain 1–512 bytes or null"
                }
                values.put(provider, value.trim())
            }
        }
        target.put(field, values)
    }

    private fun mergeModelMapPatch(target: JSONObject, field: String, raw: Any) {
        if (raw === JSONObject.NULL) {
            target.put(field, JSONObject())
            return
        }
        require(raw is JSONObject) { "$field must be an object or null" }
        val values = target.optJSONObject(field) ?: JSONObject()
        val providersPatch = raw.keys()
        while (providersPatch.hasNext()) {
            val provider = providersPatch.next()
            require(provider in providers) { "Unsupported $field key '$provider'" }
            val modelsPatch = raw.get(provider)
            if (modelsPatch === JSONObject.NULL) {
                values.remove(provider)
                continue
            }
            require(modelsPatch is JSONObject) { "$field.$provider must be an object or null" }
            val modelValues = values.optJSONObject(provider) ?: JSONObject()
            val modelKeys = modelsPatch.keys()
            while (modelKeys.hasNext()) {
                val model = modelKeys.next()
                val capability = modelsPatch.get(model)
                if (capability === JSONObject.NULL) modelValues.remove(model)
                else modelValues.put(model, capability)
            }
            if (modelValues.length() == 0) values.remove(provider) else values.put(provider, modelValues)
        }
        target.put(field, values)
    }

    private fun defaults() = JSONObject()
        .put("temperature", 0.0)
        .put("maxTokens", 8_192)
        .put("defaultMaxTurns", 25)
        .put("contextCharBudget", 150_000)
        .put("mcpToolTimeoutMs", 30_000)
        .put("maxRetries", 2)
        .put("baseRetryDelayMs", 2_000)
        .put("maxRetryDelayMs", 30_000)
        .put("defaultCronMaxTurns", 10)
        .put("defaultHeartbeatMaxTurns", 5)
        .put("defaultCronTimeoutMs", 25_000)
        .put("defaultHeartbeatTimeoutMs", 25_000)
        .put("defaultProvider", "auto")
        .put("defaultModels", JSONObject()
            .put("kilo", "kilo-auto/free")
            .put("openrouter", "openrouter/free"))
        .put("providerBaseUrls", JSONObject())
        .put("providerModelProtocols", JSONObject())
        .put("providerToolCapabilities", JSONObject())
        .put("providerModelAuthRequirements", JSONObject())
        .put("providerModelStreamingCapabilities", JSONObject())
        .put("autoRouting", JSONObject()
            .put("providerOrder", JSONArray(defaultProviderOrder))
            .put("failoverOnTransient", true)
            .put("maxFallbacks", 3))

    private fun validate(value: JSONObject): JSONObject {
        val normalized = defaults()
        normalized.put("temperature", number(value, "temperature", 0.0, 2.0, normalized.getDouble("temperature")))
        normalized.put("maxTokens", integer(value, "maxTokens", 1, 200_000, normalized.getLong("maxTokens")))
        normalized.put("defaultMaxTurns", integer(value, "defaultMaxTurns", 1, 100, normalized.getLong("defaultMaxTurns")))
        normalized.put("contextCharBudget", integer(value, "contextCharBudget", 10_000, 1_000_000, normalized.getLong("contextCharBudget")))
        normalized.put("mcpToolTimeoutMs", integer(value, "mcpToolTimeoutMs", 1_000, 300_000, normalized.getLong("mcpToolTimeoutMs")))
        normalized.put("maxRetries", integer(value, "maxRetries", 0, 5, normalized.getLong("maxRetries")))
        normalized.put("baseRetryDelayMs", integer(value, "baseRetryDelayMs", 0, 30_000, normalized.getLong("baseRetryDelayMs")))
        normalized.put("maxRetryDelayMs", integer(value, "maxRetryDelayMs", 0, 120_000, normalized.getLong("maxRetryDelayMs")))
        normalized.put("defaultCronMaxTurns", integer(value, "defaultCronMaxTurns", 1, 100, normalized.getLong("defaultCronMaxTurns")))
        normalized.put("defaultHeartbeatMaxTurns", integer(value, "defaultHeartbeatMaxTurns", 1, 100, normalized.getLong("defaultHeartbeatMaxTurns")))
        normalized.put("defaultCronTimeoutMs", integer(value, "defaultCronTimeoutMs", 1_000, 120_000, normalized.getLong("defaultCronTimeoutMs")))
        normalized.put("defaultHeartbeatTimeoutMs", integer(value, "defaultHeartbeatTimeoutMs", 1_000, 120_000, normalized.getLong("defaultHeartbeatTimeoutMs")))

        val baseDelay = normalized.getLong("baseRetryDelayMs")
        val maxDelay = normalized.getLong("maxRetryDelayMs")
        require(maxDelay >= baseDelay) { "maxRetryDelayMs must be at least baseRetryDelayMs" }

        val defaultProvider = if (value.has("defaultProvider")) value.opt("defaultProvider") else "auto"
        require(defaultProvider is String && (defaultProvider == "auto" || defaultProvider in providers)) {
            "defaultProvider must be auto or one of the configured provider ids"
        }
        normalized.put("defaultProvider", defaultProvider)

        normalized.put("defaultModels", validateStringMap(value, "defaultModels"))
        normalized.put("providerBaseUrls", validateBaseUrlMap(value))
        normalized.put("providerModelProtocols", validateModelMap(value, "providerModelProtocols"))
        normalized.put("providerToolCapabilities", validateModelMap(value, "providerToolCapabilities"))
        normalized.put("providerModelAuthRequirements", validateModelMap(value, "providerModelAuthRequirements"))
        normalized.put("providerModelStreamingCapabilities", validateModelMap(value, "providerModelStreamingCapabilities"))
        normalized.put("autoRouting", validateAutoRouting(value, defaultProvider))
        return normalized
    }

    private fun objectField(value: JSONObject, field: String): JSONObject {
        if (!value.has(field)) return JSONObject()
        return value.optJSONObject(field) ?: throw IllegalArgumentException("$field must be an object")
    }

    private fun validateStringMap(value: JSONObject, field: String): JSONObject {
        val input = objectField(value, field)
        require(input.length() <= providers.size) { "$field accepts at most ${providers.size} providers" }
        val result = JSONObject()
        val keys = input.keys()
        while (keys.hasNext()) {
            val provider = keys.next()
            require(provider in providers) { "Unsupported $field key '$provider'" }
            val model = input.get(provider)
            require(model is String && model.trim().isNotEmpty() && model.trim().toByteArray(Charsets.UTF_8).size <= 512) {
                "$field.$provider must contain 1–512 bytes"
            }
            result.put(provider, model.trim())
        }
        return result
    }

    private fun validateBaseUrlMap(value: JSONObject): JSONObject {
        val input = objectField(value, "providerBaseUrls")
        require(input.length() <= providers.size) { "providerBaseUrls accepts at most ${providers.size} providers" }
        val result = JSONObject()
        val keys = input.keys()
        while (keys.hasNext()) {
            val provider = keys.next()
            require(provider in providers && provider != "webllm") { "Unsupported providerBaseUrls key '$provider'" }
            val raw = input.get(provider)
            require(raw is String) { "providerBaseUrls.$provider must be a URL string" }
            result.put(provider, validateProviderUrl(provider, raw))
        }
        return result
    }

    private fun validateModelMap(value: JSONObject, field: String): JSONObject {
        val input = objectField(value, field)
        require(input.length() <= providers.size) { "$field accepts at most ${providers.size} providers" }
        val result = JSONObject()
        val providerKeys = input.keys()
        while (providerKeys.hasNext()) {
            val provider = providerKeys.next()
            require(provider in providers) { "Unsupported $field key '$provider'" }
            val models = input.optJSONObject(provider)
                ?: throw IllegalArgumentException("$field.$provider must be an object")
            require(models.length() <= 256) { "$field.$provider accepts at most 256 models" }
            val normalizedModels = JSONObject()
            val modelKeys = models.keys()
            while (modelKeys.hasNext()) {
                val model = modelKeys.next()
                require(model.trim().isNotEmpty() && model.toByteArray(Charsets.UTF_8).size <= 512) {
                    "$field.$provider model id must contain 1–512 bytes"
                }
                val raw = models.get(model)
                if (field == "providerModelProtocols") {
                    require(raw is String && protocolSupported(provider, raw)) {
                        "$field.$provider.$model uses an incompatible protocol"
                    }
                } else {
                    require(raw is Boolean) { "$field.$provider.$model must be boolean" }
                    if (field == "providerToolCapabilities") {
                        require(provider != "aihorde" || !raw) {
                            "providerToolCapabilities.aihorde.$model cannot be true because the published API schema has no tools field"
                        }
                    }
                }
                normalizedModels.put(model, raw)
            }
            result.put(provider, normalizedModels)
        }
        return result
    }

    private fun protocolSupported(provider: String, protocol: String): Boolean = when (provider) {
        "anthropic" -> protocol == "anthropic_messages"
        "openai" -> protocol == "openai_chat_completions" || protocol == "openai_responses"
        "gemini" -> protocol == "gemini_generate_content"
        "openrouter", "aihorde", "llm7", "kilo", "pollinations" -> protocol == "openai_chat_completions"
        "ovhcloud" -> protocol == "openai_chat_completions" || protocol == "openai_responses"
        "opencode_zen" -> protocol in setOf("anthropic_messages", "openai_chat_completions", "openai_responses", "gemini_generate_content")
        "webllm" -> protocol == "webllm_chat_completions"
        else -> false
    }

    private fun validateAutoRouting(value: JSONObject, defaultProvider: String): JSONObject {
        val raw = if (value.has("autoRouting")) objectField(value, "autoRouting") else defaults().getJSONObject("autoRouting")
        val order = if (raw.has("providerOrder")) {
            raw.optJSONArray("providerOrder") ?: throw IllegalArgumentException("autoRouting.providerOrder must be an array")
        } else defaults().getJSONObject("autoRouting").getJSONArray("providerOrder")
        require(order.length() <= providers.size) { "autoRouting.providerOrder has too many providers" }
        val normalizedOrder = JSONArray()
        val seen = HashSet<String>()
        for (index in 0 until order.length()) {
            val provider = order.opt(index)
            require(provider is String && provider in providers) { "unsupported autoRouting provider at index $index" }
            require(seen.add(provider)) { "autoRouting.providerOrder contains duplicate '$provider'" }
            normalizedOrder.put(provider)
        }
        require(defaultProvider != "auto" || normalizedOrder.length() > 0) {
            "autoRouting.providerOrder cannot be empty when defaultProvider is auto"
        }
        val failoverRaw = if (raw.has("failoverOnTransient")) raw.opt("failoverOnTransient") else true
        require(failoverRaw is Boolean) { "autoRouting.failoverOnTransient must be boolean" }
        val rawKeys = raw.keys()
        while (rawKeys.hasNext()) {
            val key = rawKeys.next()
            require(key in routingFields) { "Unknown autoRouting field '$key'" }
        }
        val maxFallbacks = integer(raw, "maxFallbacks", 0, 10, 3)
        return JSONObject()
            .put("providerOrder", normalizedOrder)
            .put("failoverOnTransient", failoverRaw)
            .put("maxFallbacks", maxFallbacks)
    }

    private fun number(value: JSONObject, key: String, min: Double, max: Double, fallback: Double): Double {
        val raw = if (value.has(key)) value.opt(key) else fallback
        require(raw is Number) { "$key must be a number" }
        val parsed = raw.toDouble()
        require(parsed.isFinite() && parsed >= min && parsed <= max) { "$key must be finite and between $min and $max" }
        return parsed
    }

    private fun integer(value: JSONObject, key: String, min: Long, max: Long, fallback: Long): Long {
        val raw = if (value.has(key)) value.opt(key) else fallback
        require(raw is Number) { "$key must be an integer" }
        val parsed = raw.toDouble()
        require(parsed.isFinite() && parsed == floor(parsed) && parsed >= min && parsed <= max) {
            "$key must be an integer between $min and $max"
        }
        return parsed.toLong()
    }

    private fun validateProviderUrl(provider: String, raw: String): String {
        val uri = try { URI(raw.trim()) } catch (error: Exception) {
            throw IllegalArgumentException("providerBaseUrls.$provider is not a valid URL", error)
        }
        val scheme = uri.scheme?.lowercase()
        require((scheme == "http" || scheme == "https") && !uri.host.isNullOrBlank()) {
            "providerBaseUrls.$provider must be an HTTP(S) URL with a host"
        }
        require(uri.userInfo == null && uri.rawQuery == null && uri.rawFragment == null) {
            "providerBaseUrls.$provider must not contain credentials, a query, or a fragment"
        }
        val normalized = raw.trim().trimEnd('/')
        require(normalized.toByteArray(Charsets.UTF_8).size <= 2_048) {
            "providerBaseUrls.$provider exceeds the 2048 byte limit"
        }
        return normalized
    }

    private fun runtimeFile(context: Context): File {
        val configPath = context.applicationContext
            .getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
            .getString(CONFIG_PATH_KEY, null)
            ?: throw IllegalStateException("NativeAgent not initialized — call initialize() first")
        val parent = File(configPath).parentFile
            ?: throw IllegalStateException("NativeAgent config path has no parent directory")
        return File(parent, FILE_NAME)
    }

    private fun writeAtomic(file: File, bytes: ByteArray) {
        val parent = file.parentFile ?: throw IllegalStateException("Runtime config path has no parent directory")
        require(parent.isDirectory || parent.mkdirs()) { "Could not create runtime config directory" }
        val atomic = AtomicFile(file)
        val stream = atomic.startWrite()
        try {
            stream.write(bytes)
            stream.flush()
            atomic.finishWrite(stream)
        } catch (error: Throwable) {
            atomic.failWrite(stream)
            throw error
        }
    }
}
