require 'json'

package = JSON.parse(File.read(File.join(File.dirname(__FILE__), 'package.json')))

Pod::Spec.new do |s|
  s.name = 'CapacitorNativeAgent'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = package['homepage'] || 'https://github.com/ArcadeLabsInc/capacitor-native-agent'
  s.author = package['author'] || 'Techxagon'
  s.source = { :git => 'https://github.com/ArcadeLabsInc/capacitor-native-agent.git', :tag => s.version.to_s }

  s.source_files = 'ios/Sources/**/*.swift'
  s.ios.deployment_target = '14.0'

  s.dependency 'Capacitor'
  s.swift_version = '5.9'

  # Prebuilt Rust xcframework (static library)
  s.vendored_frameworks = 'ios/Frameworks/NativeAgentFFI.xcframework'

  # libgit2 (bundled in Rust FFI) requires libiconv on iOS
  s.libraries = 'iconv'

  # Expose the xcframework's C headers so the Swift compiler can `canImport(native_agent_ffiFFI)`
  s.pod_target_xcconfig = {
    'OTHER_SWIFT_FLAGS[sdk=iphoneos*]' => '$(inherited) -Xcc -fmodule-map-file=${PODS_TARGET_SRCROOT}/ios/Frameworks/NativeAgentFFI.xcframework/ios-arm64/Headers/native_agent_ffiFFI.modulemap',
    'OTHER_SWIFT_FLAGS[sdk=iphonesimulator*]' => '$(inherited) -Xcc -fmodule-map-file=${PODS_TARGET_SRCROOT}/ios/Frameworks/NativeAgentFFI.xcframework/ios-arm64-simulator/Headers/native_agent_ffiFFI.modulemap',
  }
end
