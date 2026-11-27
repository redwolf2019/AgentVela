package expo.modules.t3nativecontrols

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class T3ApkUpdaterTest {
  @Test
  fun validateDownloadUrlAllowsHttpsAndLoopbackHttpOnly() {
    assertEquals(
      "https://github.com/redwolf2019/AgentVela/releases/latest",
      T3ApkUpdater.validateDownloadUrl(" https://github.com/redwolf2019/AgentVela/releases/latest ")
        .toString(),
    )
    assertEquals(
      "http://127.0.0.1:8080/app.apk",
      T3ApkUpdater.validateDownloadUrl("http://127.0.0.1:8080/app.apk").toString(),
    )
    assertThrows(IllegalArgumentException::class.java) {
      T3ApkUpdater.validateDownloadUrl("http://example.com/app.apk")
    }
    assertThrows(IllegalArgumentException::class.java) {
      T3ApkUpdater.validateDownloadUrl("file:///tmp/app.apk")
    }
    assertThrows(IllegalArgumentException::class.java) {
      T3ApkUpdater.validateDownloadUrl("https://user:pass@example.com/app.apk")
    }
  }

  @Test
  fun validateApkFileNameRejectsTraversalAndNonApk() {
    assertEquals(
      "AgentVela-0.1.11-android-arm64-v8a.apk",
      T3ApkUpdater.validateApkFileName("AgentVela-0.1.11-android-arm64-v8a.apk"),
    )
    assertThrows(IllegalArgumentException::class.java) {
      T3ApkUpdater.validateApkFileName("../evil.apk")
    }
    assertThrows(IllegalArgumentException::class.java) {
      T3ApkUpdater.validateApkFileName("app.zip")
    }
  }

  @Test
  fun validateSha256HexNormalizesAndRejectsMalformedDigests() {
    assertEquals(
      "a".repeat(64),
      T3ApkUpdater.validateSha256Hex("A".repeat(64)),
    )
    assertThrows(IllegalArgumentException::class.java) {
      T3ApkUpdater.validateSha256Hex("deadbeef")
    }
  }

  @Test
  fun assertConfinedExistingApkRestrictsReadsToUpdatesDirectory() {
    val root = Files.createTempDirectory("t3-apk-updater-test-").toFile()
    try {
      val updatesDir = File(root, "updates").apply { mkdirs() }
      val validApk = T3ApkUpdater.resolveConfinedApkFile(updatesDir, "AgentVela-0.1.11-android-arm64-v8a.apk")
      validApk.writeText("apk")
      assertEquals(validApk.canonicalFile, T3ApkUpdater.assertConfinedExistingApk(updatesDir, validApk.absolutePath))

      val outsideApk = File(root, "outside.apk").apply { writeText("outside") }
      assertThrows(IllegalArgumentException::class.java) {
        T3ApkUpdater.assertConfinedExistingApk(updatesDir, outsideApk.absolutePath)
      }
    } finally {
      root.deleteRecursively()
    }
  }
}
