Pod::Spec.new do |s|
  s.name = 'PackProofAttestation'
  s.version = '0.1.0'
  s.summary = 'PackProof biometric authorization using a device-bound signing key'
  s.description = s.summary
  s.license = { :type => 'Proprietary' }
  s.author = 'PackProof'
  s.homepage = 'https://thepackproof.com'
  s.source = { :git => 'https://thepackproof.com' }
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.0'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Security', 'LocalAuthentication', 'CryptoKit', 'UIKit'
  s.source_files = '*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
