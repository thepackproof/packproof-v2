import ExpoModulesCore
import StoreKit

public final class PackProofStorefrontModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PackProofStorefront")
    // Resolve each time: users can change their purchasing account/storefront.
    // An unavailable storefront never enables external purchase buttons.
    AsyncFunction("externalCheckoutAllowed") { () async -> Bool in
      guard let storefront = await Storefront.current else { return false }
      return storefront.countryCode == "USA"
    }
  }
}
