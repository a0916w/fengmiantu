// 文字检测工具（macOS Vision）：输入图片路径，输出文字框 JSON（左上原点、0~1 比例）
// 编译：swiftc -O ocr.swift -o ocr-bin ；服务器启动时自动编译调用
import Vision
import AppKit
import Foundation

guard CommandLine.arguments.count > 1,
      let img = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  print("[]")
  exit(0)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .fast
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = false

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try? handler.perform([request])

var boxes: [[String: Double]] = []
for obs in request.results ?? [] {
  let bb = obs.boundingBox // 归一化坐标，原点在左下
  boxes.append([
    "x": bb.origin.x,
    "y": 1 - bb.origin.y - bb.size.height,
    "w": bb.size.width,
    "h": bb.size.height,
  ])
}

let data = try! JSONSerialization.data(withJSONObject: boxes)
print(String(data: data, encoding: .utf8)!)
