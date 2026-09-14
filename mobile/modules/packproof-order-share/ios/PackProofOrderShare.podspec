Pod::Spec.new do |s|
  s.name = 'PackProofOrderShare'
  s.version = '1.0.0'
  s.summary = 'Durable iOS order sharing and on-device receipt text extraction'
  s.description = s.summary
  s.license = { :type => 'Proprietary' }
  s.author = 'PackProof LLC'
  s.homepage = 'https://thepackproof.com'
  s.platforms = { :ios => '15.1' }
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Vision', 'PDFKit', 'ImageIO', 'UniformTypeIdentifiers'
  s.swift_version = '5.0'
  s.source_files = '**/*.swift'
end
