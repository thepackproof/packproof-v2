require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'PackProofUnifiedCamera'
  s.version = package['version']
  s.summary = 'PackProof continuous evidence capture and local barcode inspection'
  s.description = 'A single AVFoundation camera session records silent H.264 MP4 evidence and detects barcodes.'
  s.license = { :type => 'Proprietary' }
  s.author = 'PackProof'
  s.homepage = 'https://thepackproof.com'
  s.platforms = { :ios => '15.1' }
  s.source = { :git => 'https://github.com/thepackproof/packproof-v2.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'Vision', 'CryptoKit', 'ImageIO', 'UIKit'
  s.swift_version = '5.0'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.resource_bundles = { 'PackProofUnifiedCamera_privacy' => ['PrivacyInfo.xcprivacy'] }
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
