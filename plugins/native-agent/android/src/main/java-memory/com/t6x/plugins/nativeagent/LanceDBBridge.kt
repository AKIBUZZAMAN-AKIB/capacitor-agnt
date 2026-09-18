package com.t6x.plugins.nativeagent

import android.content.Context
import java.io.File
import kotlinx.coroutines.runBlocking
import uniffi.lancedb_ffi.LanceDbHandle

object LanceDBBridge {
    const val EMBEDDING_DIM = 1536

    @Volatile
    private var handle: LanceDbHandle? = null

    fun getOrCreateHandle(context: Context): LanceDbHandle? {
        handle?.let { return it }
        synchronized(this) {
            handle?.let { return it }
            val dbPath = File(context.filesDir, "lancedb-memories").absolutePath
            handle = runCatching {
                runBlocking {
                    LanceDbHandle.open(dbPath, EMBEDDING_DIM)
                }
            }.getOrNull()
            return handle
        }
    }
}
