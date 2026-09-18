require 'json'

package = JSON.parse(File.read(File.join(File.dirname(__FILE__), 'package.json')))

Pod::Spec.new do |s|
  s.name = 'CapacitorNativeAgent'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://github.com/rogelioRuiz/capacitor-native-agent'
  s.author = package['author'] || 'Techxagon'
  s.source = { :git => 'https://github.com/rogelioRuiz/capacitor-native-agent.git', :tag => s.version.to_s }

  s.source_files = 'ios/Sources/**/*.swift'
  s.ios.deployment_target = '14.0'

  s.dependency 'Capacitor'
  s.swift_version = '5.9'

  # Prebuilt Rust xcframework (static library)
  s.vendored_frameworks = 'ios/Frameworks/NativeAgentFFI.xcframework'

  # libgit2 (bundled in Rust FFI) requires libiconv on iOS
  s.libraries = 'iconv'

  # Expose the xcframework's C headers so the Swift compiler can
  # `canImport(native_agent_ffiFFI)`.
  #
  # The modulemap lives in the nested `native_agent_ffi/` subdirectory of
  # each slice's Headers (created by scripts/build-ios.sh to avoid a
  # modulemap name collision). The previous spec pointed at
  # `Headers/native_agent_ffiFFI.modulemap`, which does not exist — that
  # silently broke every CocoaPods-based iOS build of this plugin.
  s.pod_target_xcconfig = {
    'OTHER_SWIFT_FLAGS[sdk=iphoneos*]' => '$(inherited) -Xcc -fmodule-map-file=${PODS_TARGET_SRCROOT}/ios/Frameworks/NativeAgentFFI.xcframework/ios-arm64/Headers/native_agent_ffi/module.modulemap',
    'OTHER_SWIFT_FLAGS[sdk=iphonesimulator*]' => '$(inherited) -Xcc -fmodule-map-file=${PODS_TARGET_SRCROOT}/ios/Frameworks/NativeAgentFFI.xcframework/ios-arm64-simulator/Headers/native_agent_ffi/module.modulemap',
  }
end
