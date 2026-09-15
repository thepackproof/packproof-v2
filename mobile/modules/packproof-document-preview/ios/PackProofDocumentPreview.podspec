Pod::Spec.new do |s|
  s.name = 'PackProofDocumentPreview'
  s.version = '0.1.0'
  s.summary = 'Native local PDF review for PackProof document approval'
  s.description = s.summary
  s.license = { :type => 'Proprietary' }
  s.author = 'PackProof'
  s.homepage = 'https://thepackproof.com'
  s.source = { :git => 'https://github.com/thepackproof/packproof-v2.git' }
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.0'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'QuickLook', 'PDFKit', 'UIKit'
  s.source_files = '*.swift'
  s.resource_bundles = { 'PackProofDocumentPreview_privacy' => ['PrivacyInfo.xcprivacy'] }
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
