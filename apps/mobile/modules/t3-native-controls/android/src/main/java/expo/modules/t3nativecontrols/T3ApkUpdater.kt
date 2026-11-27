package expo.modules.t3nativecontrols

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest

internal object T3ApkUpdater {
  private const val UPDATES_SUBDIR = "updates"
  private const val APK_MIME_TYPE = "application/vnd.android.package-archive"
  private const val BUFFER_BYTES = 65_536
  private const val CONNECT_TIMEOUT_MS = 15_000
  private const val READ_TIMEOUT_MS = 30_000
  private const val MAX_REDIRECTS = 5
  private const val PROGRESS_INTERVAL_NS = 150_000_000L
  private const val HTTP_OK_START = 200
  private const val HTTP_OK_END = 299
  private val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)
  private val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "::1")
  private val SAFE_APK_FILE_REGEX = Regex("^[A-Za-z0-9._-]+\\.apk$")
  private val SHA256_HEX_REGEX = Regex("^[0-9a-fA-F]{64}$")

  internal fun validateDownloadUrl(rawUrl: String): URI {
    val trimmed = rawUrl.trim()
    require(trimmed.isNotEmpty()) { "Download URL must not be empty." }
    val uri = URI(trimmed)
    require(uri.rawUserInfo.isNullOrEmpty()) { "Download URL must not contain credentials." }
    val scheme = uri.scheme?.lowercase() ?: throw IllegalArgumentException("Missing URL scheme.")
    val rawHost = uri.host?.lowercase() ?: throw IllegalArgumentException("Missing URL host.")
    val host = rawHost.removePrefix("[").removeSuffix("]")
    when (scheme) {
      "https" -> Unit
      "http" -> require(host in LOOPBACK_HOSTS) {
        "Cleartext HTTP APK downloads are allowed only for loopback hosts."
      }
      else -> throw IllegalArgumentException("Unsupported APK URL scheme: $scheme")
    }
    return uri
  }

  internal fun validateApkFileName(fileName: String): String {
    val trimmed = fileName.trim()
    require(trimmed.isNotEmpty() && trimmed == fileName) { "Invalid APK file name." }
    require(
      !trimmed.contains("/") &&
        !trimmed.contains("\\") &&
        !trimmed.contains("..") &&
        trimmed.none { it.code < 0x20 || it.code == 0x7f },
    ) { "APK file name contains unsafe characters." }
    require(SAFE_APK_FILE_REGEX.matches(trimmed)) { "APK file name must end with .apk." }
    return trimmed
  }

  internal fun validateSha256Hex(expectedSha256: String): String {
    val trimmed = expectedSha256.trim()
    require(SHA256_HEX_REGEX.matches(trimmed)) { "Expected SHA-256 digest must be 64 hex chars." }
    return trimmed.lowercase()
  }

  internal fun updatesDirectory(cacheDir: File): File = File(cacheDir, UPDATES_SUBDIR)

  internal fun resolveConfinedApkFile(updatesDir: File, fileName: String): File {
    val validName = validateApkFileName(fileName)
    val canonicalRoot = updatesDir.canonicalFile
    val candidate = File(canonicalRoot, validName).canonicalFile
    require(candidate.parentFile == canonicalRoot && candidate.name == validName) {
      "Resolved APK path escapes updates cache directory."
    }
    return candidate
  }

  internal fun assertConfinedExistingApk(updatesDir: File, filePath: String): File {
    val canonicalRoot = updatesDir.canonicalFile
    val candidate = File(filePath).canonicalFile
    require(candidate.parentFile == canonicalRoot) { "APK path is outside the updates directory." }
    validateApkFileName(candidate.name)
    require(candidate.isFile) { "Downloaded APK file does not exist." }
    return candidate
  }

  fun canRequestPackageInstalls(context: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
      context.packageManager.canRequestPackageInstalls()

  fun openInstallUnknownAppsSettings(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val intent = Intent(
      Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
      Uri.parse("package:${context.packageName}"),
    ).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(intent)
  }

  fun downloadAndVerifyApk(
    context: Context,
    url: String,
    fileName: String,
    expectedSha256: String,
    onProgress: (downloadedBytes: Long, totalBytes: Long?) -> Unit,
  ): String {
    validateDownloadUrl(url)
    val validSha = validateSha256Hex(expectedSha256)
    val updatesDir = updatesDirectory(context.cacheDir)
    check(updatesDir.exists() || updatesDir.mkdirs()) { "Could not create APK cache directory." }
    val targetFile = resolveConfinedApkFile(updatesDir, fileName)
    pruneOldFiles(updatesDir, targetFile.name)
    val partFile = File(targetFile.parentFile, "${targetFile.name}.part")
    if (partFile.exists()) partFile.delete()
    var moved = false
    val connection = openValidatedConnection(url)
    try {
      streamAndVerifyToPartFile(connection, partFile, validSha, onProgress)
      if (targetFile.exists() && !targetFile.delete()) {
        error("Could not replace existing cached APK.")
      }
      check(partFile.renameTo(targetFile)) { "Could not finalize downloaded APK file." }
      moved = true
      return targetFile.absolutePath
    } finally {
      connection.disconnect()
      if (!moved && partFile.exists()) {
        partFile.delete()
      }
    }
  }

  fun installApk(context: Context, filePath: String) {
    check(canRequestPackageInstalls(context)) {
      "Permission to install unknown apps is required."
    }
    val apkFile = assertConfinedExistingApk(updatesDirectory(context.cacheDir), filePath)
    val contentUri = FileProvider.getUriForFile(
      context,
      "${context.packageName}.FileSystemFileProvider",
      apkFile,
    )
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(contentUri, APK_MIME_TYPE)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(intent)
  }

  private fun pruneOldFiles(updatesDir: File, keepFileName: String) {
    val entries = updatesDir.listFiles() ?: return
    for (entry in entries) {
      if (entry.isFile && entry.name != keepFileName) {
        entry.delete()
      }
    }
  }

  private fun openValidatedConnection(initialUrl: String): HttpURLConnection {
    var currentUri = validateDownloadUrl(initialUrl)
    repeat(MAX_REDIRECTS + 1) {
      val connection = (currentUri.toURL().openConnection() as HttpURLConnection).apply {
        instanceFollowRedirects = false
        connectTimeout = CONNECT_TIMEOUT_MS
        readTimeout = READ_TIMEOUT_MS
        setRequestProperty("Accept", "*/*")
      }
      connection.connect()
      val code = connection.responseCode
      if (code in REDIRECT_CODES) {
        val location = connection.getHeaderField("Location")
        connection.disconnect()
        require(!location.isNullOrBlank()) { "Redirect response missing Location header." }
        currentUri = validateDownloadUrl(currentUri.resolve(location).toString())
      } else if (code in HTTP_OK_START..HTTP_OK_END) {
        return connection
      } else {
        connection.disconnect()
        error("HTTP $code while downloading update APK.")
      }
    }
    error("Too many redirects while downloading update APK.")
  }

  private fun streamAndVerifyToPartFile(
    connection: HttpURLConnection,
    partFile: File,
    expectedSha256: String,
    onProgress: (downloadedBytes: Long, totalBytes: Long?) -> Unit,
  ) {
    val totalBytes = connection.contentLengthLong.takeIf { it > 0L }
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(BUFFER_BYTES)
    var downloadedBytes = 0L
    var lastProgressNs = 0L
    connection.inputStream.use { input ->
      FileOutputStream(partFile).use { output ->
        while (true) {
          val read = input.read(buffer)
          if (read <= 0) break
          output.write(buffer, 0, read)
          digest.update(buffer, 0, read)
          downloadedBytes += read
          val nowNs = System.nanoTime()
          if (lastProgressNs == 0L || nowNs - lastProgressNs >= PROGRESS_INTERVAL_NS) {
            onProgress(downloadedBytes, totalBytes)
            lastProgressNs = nowNs
          }
        }
        output.fd.sync()
      }
    }
    onProgress(downloadedBytes, totalBytes)
    val actualSha256 = digest.digest().joinToString("") { "%02x".format(it) }
    check(actualSha256 == expectedSha256) {
      "Downloaded APK SHA-256 verification failed."
    }
  }
}
