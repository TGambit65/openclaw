package ai.openclaw.android.gateway

import android.content.ContextWrapper
import java.io.File
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeviceIdentityStoreTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun loadOrCreateStoresIdentityInNoBackupDir() {
    val context = RuntimeEnvironment.getApplication()
    val store = DeviceIdentityStore(context)

    val identity = store.loadOrCreate()

    val stored = readIdentityFile(context.noBackupFilesDir)
    assertEquals(identity.deviceId, stored.deviceId)
    assertFalse(File(context.filesDir, IDENTITY_RELATIVE_PATH).exists())
  }

  @Test
  fun loadOrCreateMigratesLegacyIdentityOutOfBackupDir() {
    val context = RuntimeEnvironment.getApplication()
    val legacyIdentity = writeLegacyIdentity(context)
    val legacyFile = File(context.filesDir, IDENTITY_RELATIVE_PATH)

    val migrated = DeviceIdentityStore(context).loadOrCreate()

    assertEquals(legacyIdentity, migrated)
    assertTrue(File(context.noBackupFilesDir, IDENTITY_RELATIVE_PATH).exists())
    assertFalse("legacy identity file should be removed after migration", legacyFile.exists())
  }

  @Test
  fun loadOrCreateKeepsLegacyIdentityWhenMigrationWriteFails() {
    val baseContext = RuntimeEnvironment.getApplication()
    val legacyIdentity = writeLegacyIdentity(baseContext)
    val legacyFile = File(baseContext.filesDir, IDENTITY_RELATIVE_PATH)
    val blockingFile = File(baseContext.cacheDir, "blocked-no-backup")
    blockingFile.writeText("not-a-directory", Charsets.UTF_8)
    val context =
      object : ContextWrapper(baseContext) {
        override fun getNoBackupFilesDir(): File = blockingFile
      }

    val loaded = DeviceIdentityStore(context).loadOrCreate()

    assertEquals(legacyIdentity, loaded)
    assertTrue("legacy identity file should remain if migration fails", legacyFile.exists())
    assertFalse(File(blockingFile, IDENTITY_RELATIVE_PATH).exists())
  }

  private fun writeLegacyIdentity(parentContext: android.content.Context): DeviceIdentity {
    val legacyFile = File(parentContext.filesDir, IDENTITY_RELATIVE_PATH)
    legacyFile.parentFile?.mkdirs()
    val legacyIdentity =
      DeviceIdentity(
        deviceId = "legacy-device-id",
        publicKeyRawBase64 = "legacy-public",
        privateKeyPkcs8Base64 = "legacy-private",
        createdAtMs = 1234L,
      )
    legacyFile.writeText(json.encodeToString(DeviceIdentity.serializer(), legacyIdentity), Charsets.UTF_8)
    return legacyIdentity
  }

  private fun readIdentityFile(parent: File): DeviceIdentity {
    val file = File(parent, IDENTITY_RELATIVE_PATH)
    assertTrue(file.exists())
    return json.decodeFromString(DeviceIdentity.serializer(), file.readText(Charsets.UTF_8))
  }

  companion object {
    private const val IDENTITY_RELATIVE_PATH = "openclaw/identity/device.json"
  }
}
