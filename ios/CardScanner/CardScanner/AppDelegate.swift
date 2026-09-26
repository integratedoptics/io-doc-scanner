import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions:
                     [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let w = UIWindow(frame: UIScreen.main.bounds)
        w.rootViewController = ScannerViewController()
        w.backgroundColor = Brand.canvas
        window = w
        w.makeKeyAndVisible()
        return true
    }
}

/// Integrated Optics brand colours (brandbook p.13–14).
enum Brand {
    static let black  = UIColor(red: 0x1d / 255, green: 0x1d / 255, blue: 0x1b / 255, alpha: 1)
    static let orange = UIColor(red: 1.0,        green: 0xa4 / 255, blue: 0x50 / 255, alpha: 1)
    static let canvas = UIColor(red: 0xef / 255, green: 0xef / 255, blue: 0xef / 255, alpha: 1)
}
