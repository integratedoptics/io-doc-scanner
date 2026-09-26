import UIKit
import WebKit
import Vision
import PhotosUI

/// Hosts the shared web UI in a WKWebView and serves every native request the
/// web layer makes: camera, photo library, on-device OCR (Vision), file writing
/// into the app's Documents folder, the share sheet and the optional AI call.
final class ScannerViewController: UIViewController {

    private var web: WKWebView!

    // MARK: - lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Brand.black

        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()          // localStorage survives restarts
        cfg.allowsInlineMediaPlayback = true
        cfg.userContentController.add(self, name: "native")
        cfg.userContentController.addUserScript(
            WKUserScript(source: bootstrapJS(), injectionTime: .atDocumentStart,
                         forMainFrameOnly: true))
        if #available(iOS 14.0, *) {
            cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        }

        web = WKWebView(frame: .zero, configuration: cfg)
        web.translatesAutoresizingMaskIntoConstraints = false
        web.scrollView.bounces = false
        web.isOpaque = false
        web.backgroundColor = Brand.canvas
        web.scrollView.backgroundColor = Brand.canvas
        web.allowsBackForwardNavigationGestures = false
        if #available(iOS 16.4, *) { web.isInspectable = true }
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])

        guard let index = Bundle.main.url(forResource: "index", withExtension: "html",
                                         subdirectory: "web") else {
            showFatal("The web assets are missing from the app bundle.")
            return
        }
        web.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    /// Injected before the page scripts run: the version string, the base64
    /// Excel templates and the bridge shim itself.
    private func bootstrapJS() -> String {
        let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "1.1"
        var assets: [String: String] = [:]
        for name in ["template-contact.xlsx", "template-address.xlsx"] {
            let base = (name as NSString).deletingPathExtension
            if let u = Bundle.main.url(forResource: base, withExtension: "xlsx", subdirectory: "web"),
               let d = try? Data(contentsOf: u) {
                assets[name] = d.base64EncodedString()
            }
        }
        let assetsJSON = (try? JSONSerialization.data(withJSONObject: assets))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        let bridge = Bundle.main.url(forResource: "ios-bridge", withExtension: "js")
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        return """
        window.CS_VERSION = \(jsString(version));
        window.CS_ASSETS = \(assetsJSON);
        \(bridge)
        """
    }

    // MARK: - calling back into the page

    private func js(_ code: String) {
        DispatchQueue.main.async { self.web.evaluateJavaScript(code, completionHandler: nil) }
    }

    private func jsString(_ s: String) -> String {
        let d = (try? JSONSerialization.data(withJSONObject: [s], options: []))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return String(d.dropFirst().dropLast())
    }

    private func sendScan(ok: Bool, text: String = "", error: String = "",
                          image: String = "", thumb: String = "", lines: [String] = []) {
        let payload: [String: Any] = ["ok": ok, "text": text, "error": error,
                                      "image": image, "thumb": thumb, "lines": lines]
        guard let d = try? JSONSerialization.data(withJSONObject: payload),
              let s = String(data: d, encoding: .utf8) else { return }
        js("window.onScan(\(s))")
    }

    private func presentToast(_ msg: String) {
        DispatchQueue.main.async {
            let label = PaddedLabel()
            label.text = msg
            label.numberOfLines = 0
            label.textColor = .white
            label.font = .systemFont(ofSize: 14, weight: .medium)
            label.textAlignment = .center
            label.backgroundColor = Brand.black.withAlphaComponent(0.94)
            label.layer.cornerRadius = 12
            label.clipsToBounds = true
            label.alpha = 0
            label.translatesAutoresizingMaskIntoConstraints = false
            self.view.addSubview(label)
            NSLayoutConstraint.activate([
                label.centerXAnchor.constraint(equalTo: self.view.centerXAnchor),
                label.bottomAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.bottomAnchor,
                                              constant: -84),
                label.widthAnchor.constraint(lessThanOrEqualTo: self.view.widthAnchor, multiplier: 0.86)
            ])
            UIView.animate(withDuration: 0.2) { label.alpha = 1 }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.4) {
                UIView.animate(withDuration: 0.25, animations: { label.alpha = 0 }) { _ in
                    label.removeFromSuperview()
                }
            }
        }
    }

    private func showFatal(_ msg: String) {
        DispatchQueue.main.async {
            let a = UIAlertController(title: "Card Scanner", message: msg, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default))
            self.present(a, animated: true)
        }
    }

    // MARK: - card image storage

    private var cardsDir: URL {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("cards", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private var documentsDir: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    // MARK: - capture

    private func openCamera() {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            sendScan(ok: false, error: "This device has no camera.")
            return
        }
        let p = UIImagePickerController()
        p.sourceType = .camera
        p.cameraCaptureMode = .photo
        p.delegate = self
        present(p, animated: true)
    }

    private func openLibrary() {
        if #available(iOS 14.0, *) {
            var c = PHPickerConfiguration(photoLibrary: .shared())
            c.filter = .images
            c.selectionLimit = 1
            let p = PHPickerViewController(configuration: c)
            p.delegate = self
            present(p, animated: true)
        } else {
            let p = UIImagePickerController()
            p.sourceType = .photoLibrary
            p.delegate = self
            present(p, animated: true)
        }
    }

    /// Downscale, store, OCR, hand the result back to the page.
    private func handle(image: UIImage) {
        DispatchQueue.global(qos: .userInitiated).async {
            let big = Self.scaled(image, maxSide: 1800)
            let name = "card-\(Int(Date().timeIntervalSince1970 * 1000)).jpg"
            var imageRef = ""
            if let jpg = big.jpegData(compressionQuality: 0.86) {
                let url = self.cardsDir.appendingPathComponent(name)
                if (try? jpg.write(to: url)) != nil { imageRef = name }
            }
            let small = Self.scaled(big, maxSide: 420)
            let thumb = small.jpegData(compressionQuality: 0.7)
                .map { "data:image/jpeg;base64," + $0.base64EncodedString() } ?? ""
            self.ocr(big) { lines in
                self.sendScan(ok: true, text: lines.joined(separator: "\n"),
                              image: imageRef, thumb: thumb, lines: lines)
            }
        }
    }

    private static func scaled(_ img: UIImage, maxSide: CGFloat) -> UIImage {
        let w = img.size.width, h = img.size.height
        let side = max(w, h)
        guard side > maxSide, side > 0 else { return img }
        let f = maxSide / side
        let size = CGSize(width: (w * f).rounded(), height: (h * f).rounded())
        let r = UIGraphicsImageRenderer(size: size)
        return r.image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
    }

    // MARK: - Vision OCR

    /// Recognises text on the device and returns the lines in reading order:
    /// grouped into rows by vertical position, then left to right, which is what
    /// the shared parser in app.js expects.
    private func ocr(_ image: UIImage, done: @escaping ([String]) -> Void) {
        guard let cg = image.cgImage else { done([]); return }
        let req = VNRecognizeTextRequest { request, error in
            if let error = error {
                self.sendScan(ok: false, error: "Text recognition failed: \(error.localizedDescription)")
                return
            }
            let obs = (request.results as? [VNRecognizedTextObservation]) ?? []
            var items: [(y: CGFloat, x: CGFloat, h: CGFloat, s: String)] = []
            for o in obs {
                guard let c = o.topCandidates(1).first else { continue }
                let b = o.boundingBox                    // origin bottom-left, normalised
                items.append((y: 1 - b.origin.y - b.height, x: b.origin.x, h: b.height, s: c.string))
            }
            done(Self.orderLines(items))
        }
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = false               // keep names and codes verbatim
        if #available(iOS 16.0, *) {
            req.revision = VNRecognizeTextRequestRevision3
            req.recognitionLanguages = ["en-US", "lt-LT", "de-DE", "fr-FR", "pl-PL"]
        } else {
            req.recognitionLanguages = ["en-US"]
        }
        let handler = VNImageRequestHandler(cgImage: cg, orientation: Self.cgOrientation(image),
                                           options: [:])
        do { try handler.perform([req]) }
        catch { sendScan(ok: false, error: "Text recognition failed: \(error.localizedDescription)") }
    }

    /// Same geometric line ordering as the Android build's orderedText().
    static func orderLines(_ items: [(y: CGFloat, x: CGFloat, h: CGFloat, s: String)]) -> [String] {
        guard !items.isEmpty else { return [] }
        let sorted = items.sorted { $0.y < $1.y }
        var rows: [[(y: CGFloat, x: CGFloat, h: CGFloat, s: String)]] = []
        for it in sorted {
            let tol = max(it.h * 0.6, 0.012)
            if var last = rows.last, let ref = last.first, abs(ref.y - it.y) <= tol {
                last.append(it)
                rows[rows.count - 1] = last
            } else {
                rows.append([it])
            }
        }
        return rows.map { row in
            row.sorted { $0.x < $1.x }.map { $0.s }.joined(separator: "  ")
        }
    }

    private static func cgOrientation(_ img: UIImage) -> CGImagePropertyOrientation {
        switch img.imageOrientation {
        case .up: return .up
        case .down: return .down
        case .left: return .left
        case .right: return .right
        case .upMirrored: return .upMirrored
        case .downMirrored: return .downMirrored
        case .leftMirrored: return .leftMirrored
        case .rightMirrored: return .rightMirrored
        @unknown default: return .up
        }
    }

    // MARK: - files

    private func saveFile(name: String, base64: String, mime: String) {
        guard let data = Data(base64Encoded: base64) else {
            presentToast("Could not build \(name)")
            return
        }
        let safe = name.replacingOccurrences(of: "/", with: "-")
        let url = documentsDir.appendingPathComponent(safe)
        do {
            try data.write(to: url, options: .atomic)
            presentToast("Saved to Files › Card Scanner")
        } catch {
            presentToast("Could not save \(safe): \(error.localizedDescription)")
        }
    }

    private func shareFiles(urisJson: String, title: String) {
        var urls: [URL] = []
        if let d = urisJson.data(using: .utf8),
           let arr = try? JSONSerialization.jsonObject(with: d) as? [String] {
            for s in arr {
                let name = (s as NSString).lastPathComponent
                let u = documentsDir.appendingPathComponent(name)
                if FileManager.default.fileExists(atPath: u.path) { urls.append(u) }
            }
        }
        guard !urls.isEmpty else { presentToast("Nothing to share yet."); return }
        DispatchQueue.main.async {
            let a = UIActivityViewController(activityItems: urls, applicationActivities: nil)
            a.popoverPresentationController?.sourceView = self.view
            a.popoverPresentationController?.sourceRect =
                CGRect(x: self.view.bounds.midX, y: self.view.bounds.midY, width: 1, height: 1)
            self.present(a, animated: true)
        }
    }

    // MARK: - optional AI call

    private func httpPostJson(url: String, headersJson: String, body: String,
                              timeout: Double, reqId: String) {
        guard let u = URL(string: url), u.scheme == "https" else {
            js("window.onHttp(\(jsString(reqId)),\(jsString("ERR:the endpoint must be an https URL")))")
            return
        }
        var r = URLRequest(url: u)
        r.httpMethod = "POST"
        r.timeoutInterval = max(5, min(timeout, 120))
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let d = headersJson.data(using: .utf8),
           let h = try? JSONSerialization.jsonObject(with: d) as? [String: String] {
            for (k, v) in h { r.setValue(v, forHTTPHeaderField: k) }
        }
        r.httpBody = body.data(using: .utf8)
        URLSession.shared.dataTask(with: r) { data, _, err in
            let payload: String
            if let err = err {
                payload = "ERR:" + err.localizedDescription
            } else {
                payload = data.flatMap { String(data: $0, encoding: .utf8) } ?? "ERR:empty response"
            }
            self.js("window.onHttp(\(self.jsString(reqId)),\(self.jsString(payload)))")
        }.resume()
    }

    // MARK: - general request, used for the ERPNext sync

    /* One shared session so the Frappe sid cookie set by /api/method/login is
       reused by the calls that follow it. Unlike httpPostJson above this one
       allows any method and reports the status code back, because a duplicate
       check is a GET and a 401 has to be told apart from a 417. */
    private lazy var netSession: URLSession = {
        let c = URLSessionConfiguration.default
        c.httpCookieAcceptPolicy = .always
        c.httpShouldSetCookies = true
        c.httpCookieStorage = HTTPCookieStorage.shared
        return URLSession(configuration: c)
    }()

    /// Plain http is only tolerated on a local network address; the web layer
    /// enforces the same rule before it ever gets here.
    private func localHost(_ host: String) -> Bool {
        if host == "localhost" || host == "127.0.0.1" || host.hasSuffix(".local") { return true }
        if host.hasPrefix("192.168.") || host.hasPrefix("10.") { return true }
        if host.hasPrefix("172.") {
            let p = host.split(separator: ".")
            if p.count > 1, let n = Int(p[1]), n >= 16, n <= 31 { return true }
        }
        return false
    }

    private func httpRequest(method: String, url: String, headersJson: String,
                             body: String, timeout: Double, reqId: String) {
        func fail(_ m: String) {
            js("window.onHttp(\(jsString(reqId)),\(jsString("ERR:" + m)))")
        }
        guard let u = URL(string: url), let host = u.host else {
            return fail("that is not a valid address")
        }
        if u.scheme == "http" {
            if !localHost(host) { return fail("plain http is only allowed on a local address") }
        } else if u.scheme != "https" {
            return fail("the address must start with https")
        }

        var r = URLRequest(url: u)
        r.httpMethod = method.uppercased()
        r.timeoutInterval = max(5, min(timeout, 120))
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let d = headersJson.data(using: .utf8),
           let h = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
            for (k, v) in h { r.setValue(String(describing: v), forHTTPHeaderField: k) }
        }
        let m = r.httpMethod ?? "GET"
        if m != "GET" && m != "HEAD" && !body.isEmpty {
            r.httpBody = body.data(using: .utf8)
        }

        netSession.dataTask(with: r) { data, resp, err in
            let payload: String
            if let err = err {
                payload = "ERR:" + err.localizedDescription
            } else {
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                let obj: [String: Any] = ["status": code, "body": text]
                if let out = try? JSONSerialization.data(withJSONObject: obj),
                   let s = String(data: out, encoding: .utf8) {
                    payload = s
                } else {
                    payload = "ERR:the reply could not be read"
                }
            }
            self.js("window.onHttp(\(self.jsString(reqId)),\(self.jsString(payload)))")
        }.resume()
    }
}

// MARK: - JS -> native

extension ScannerViewController: WKScriptMessageHandler {
    func userContentController(_ ucc: WKUserContentController,
                              didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let fn = body["fn"] as? String else { return }
        let args = (body["args"] as? [Any]) ?? []
        func str(_ i: Int) -> String { i < args.count ? String(describing: args[i]) : "" }

        switch fn {
        case "toast":
            presentToast(str(0))
        case "takePhoto":
            openCamera()
        case "pickPhoto":
            openLibrary()
        case "reOcr":
            let name = str(0)
            let url = cardsDir.appendingPathComponent(name)
            if let d = try? Data(contentsOf: url), let img = UIImage(data: d) {
                ocr(img) { lines in
                    self.sendScan(ok: true, text: lines.joined(separator: "\n"),
                                  image: name, thumb: "", lines: lines)
                }
            } else {
                sendScan(ok: false, error: "The stored picture is no longer on this device.")
            }
        case "deleteCardImage":
            try? FileManager.default.removeItem(at: cardsDir.appendingPathComponent(str(0)))
        case "saveFile":
            saveFile(name: str(0), base64: str(1), mime: str(2))
        case "shareFiles":
            shareFiles(urisJson: str(0), title: str(1))
        case "httpRequest":
            let t = Double(str(4)) ?? 30
            httpRequest(method: str(0), url: str(1), headersJson: str(2), body: str(3),
                        timeout: t, reqId: str(5))
        case "httpPostJson":
            let t = (args.count > 3 ? (args[3] as? NSNumber)?.doubleValue : 30) ?? 30
            httpPostJson(url: str(0), headersJson: str(1), body: str(2), timeout: t, reqId: str(4))
        default:
            break
        }
    }
}

// MARK: - pickers

extension ScannerViewController: UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    func imagePickerController(_ picker: UIImagePickerController,
                              didFinishPickingMediaWithInfo info:
                              [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        if let img = (info[.editedImage] as? UIImage) ?? (info[.originalImage] as? UIImage) {
            handle(image: img)
        } else {
            sendScan(ok: false, error: "No picture came back from the camera.")
        }
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        js("window.onScanCancelled && window.onScanCancelled()")
    }
}

@available(iOS 14.0, *)
extension ScannerViewController: PHPickerViewControllerDelegate {
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let item = results.first?.itemProvider,
              item.canLoadObject(ofClass: UIImage.self) else {
            js("window.onScanCancelled && window.onScanCancelled()")
            return
        }
        item.loadObject(ofClass: UIImage.self) { obj, _ in
            if let img = obj as? UIImage {
                self.handle(image: img)
            } else {
                self.sendScan(ok: false, error: "That picture could not be opened.")
            }
        }
    }
}

/// A label with inner padding, used for the toast.
final class PaddedLabel: UILabel {
    private let inset = UIEdgeInsets(top: 10, left: 16, bottom: 10, right: 16)
    override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: inset)) }
    override var intrinsicContentSize: CGSize {
        let s = super.intrinsicContentSize
        return CGSize(width: s.width + inset.left + inset.right,
                      height: s.height + inset.top + inset.bottom)
    }
    override func textRect(forBounds bounds: CGRect,
                           limitedToNumberOfLines n: Int) -> CGRect {
        let r = super.textRect(forBounds: bounds.inset(by: inset), limitedToNumberOfLines: n)
        return r.inset(by: UIEdgeInsets(top: -inset.top, left: -inset.left,
                                        bottom: -inset.bottom, right: -inset.right))
    }
}
