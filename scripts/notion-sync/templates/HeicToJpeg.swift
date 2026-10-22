// Compile once on macOS. Decode only bounded HEIC still images from private local files.
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Darwin

func convert() -> Bool {
    guard CommandLine.arguments.count == 3 else { return false }
    umask(0o077)
    let input = URL(fileURLWithPath: CommandLine.arguments[1])
    let output = URL(fileURLWithPath: CommandLine.arguments[2])
    guard let data = try? Data(contentsOf: input), !data.isEmpty, data.count <= 20 * 1024 * 1024,
          let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
          let type = CGImageSourceGetType(source) as String?, ["public.heic", "public.heif"].contains(type),
          CGImageSourceGetCount(source) == 1,
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
          let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
          width.intValue > 0, height.intValue > 0, width.intValue <= 16000, height.intValue <= 16000,
          width.intValue * height.intValue <= 64_000_000 else { return false }
    let settings: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 4096,
        kCGImageSourceShouldCacheImmediately: true]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, settings as CFDictionary),
          let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return false }
    // Add decoded pixels, never source metadata. GPS, EXIF dates and XMP are not copied.
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.9,
        kCGImagePropertyOrientation: 1, kCGImageMetadataShouldExcludeGPS: true,
        kCGImageMetadataShouldExcludeXMP: true] as CFDictionary)
    guard CGImageDestinationFinalize(destination),
          let size = try? output.resourceValues(forKeys: [.fileSizeKey]).fileSize,
          size > 0, size <= 20 * 1024 * 1024 else { return false }
    return true
}
exit(convert() ? 0 : 1)
