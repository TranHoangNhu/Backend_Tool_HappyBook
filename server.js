const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const { convert } = require("pdf-poppler"); // Dùng để chuyển PDF thành ảnh
const pdfkit = require("pdfkit"); // Thay thế Muhammara bằng PDFKit

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });
let progress = { completedPages: 0, totalPages: 0 }; // Cập nhật progress thành đối tượng chứa thông tin số trang

// Endpoint SSE để gửi tiến trình nén cho client
app.get("/compress/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendProgress = () => {
    res.write(`data: ${JSON.stringify(progress)}\n\n`); // Gửi progress dưới dạng JSON
  };

  const intervalId = setInterval(sendProgress, 500);

  req.on("close", () => {
    clearInterval(intervalId);
  });
});

app.post("/compress", upload.single("file"), async (req, res) => {
  if (!req.file) {
    console.error("No file uploaded");
    return res.status(400).send("No file uploaded");
  }

  const inputPath = req.file.path;
  const tempPdfPath = path.resolve("uploads", "temp_converted.pdf");

  try {
    console.log("Starting PDF to image conversion...");
    console.log("Input PDF Path:", inputPath);
    // Đọc PDF và chuyển mỗi trang thành hình ảnh với chất lượng 30
    const options = {
      format: "jpeg",
      out_dir: "uploads",
      out_prefix: path.basename(inputPath, path.extname(inputPath)),
      page: null,
      scale: 1000,
    };
    console.log("Conversion options:", options);

    await convert(inputPath, options).catch((error) => {
      console.error("Error converting PDF to images:", error);
      throw error;
    });

    // Lấy danh sách các file ảnh được tạo ra và sắp xếp chúng
    let imageFiles = fs
      .readdirSync(options.out_dir)
      .filter(
        (file) =>
          file.startsWith(options.out_prefix) &&
          (file.endsWith(".jpg") || file.endsWith(".jpeg"))
      );
    imageFiles = imageFiles.sort((a, b) => {
      const aPage = parseInt(a.split("-").pop().split(".")[0]);
      const bPage = parseInt(b.split("-").pop().split(".")[0]);
      return aPage - bPage;
    });

    if (imageFiles.length === 0) {
      console.error(
        "Conversion did not produce any images. Please check the input file."
      );
      return res.status(500).send("Error converting PDF to images");
    }

    const totalPages = imageFiles.length;
    progress.totalPages = totalPages;
    console.log(`Total pages to convert: ${totalPages}`);

    // Sử dụng Dynamic Import để nén các file JPEG bằng MozJPEG
    const imagemin = (await import("imagemin")).default;
    const imageminMozjpeg = (await import("imagemin-mozjpeg")).default;

    await imagemin(
      imageFiles.map((file) => path.resolve("uploads", file)),
      {
        destination: "uploads/compressed",
        plugins: [imageminMozjpeg({ quality: 300 })],
      }
    );

    // Cập nhật danh sách file ảnh đã nén
    imageFiles = fs
      .readdirSync("uploads/compressed")
      .filter(
        (file) =>
          file.startsWith(options.out_prefix) &&
          (file.endsWith(".jpg") || file.endsWith(".jpeg"))
      );

    // Tạo một file PDF mới từ các hình ảnh đã nén bằng PDFKit
    console.log("Creating new PDF with images using PDFKit...");
    const doc = new pdfkit();
    const writeStream = fs.createWriteStream(tempPdfPath);
    doc.pipe(writeStream);

    writeStream.on("error", (err) => {
      console.error("Error with writeStream:", err);
    });

    for (let i = 0; i < totalPages; i++) {
      progress.completedPages = i + 1;
      const imgPath = path.resolve("uploads/compressed", imageFiles[i]);

      console.log(`Processing page ${i + 1}, image path: ${imgPath}`);
      // Thêm hình ảnh đã chuyển đổi vào tài liệu PDF
      if (fs.existsSync(imgPath)) {
        console.log(`Image file found: ${imgPath}`);
        const dimensions = doc.openImage(imgPath);
        doc.addPage({ size: [dimensions.width, dimensions.height] });
        doc.image(imgPath, 0, 0);
        console.log(`Added image ${imgPath} to PDF.`);
      } else {
        console.error(`Image file not found: ${imgPath}`);
      }
    }

    doc.end();

    writeStream.on("finish", () => {
      console.log("Image-based PDF created at:", tempPdfPath);
      res.download(tempPdfPath, (err) => {
        if (err) {
          console.error("Error during download:", err);
          return res.status(500).send("Error downloading PDF");
        }

        console.log("PDF downloaded successfully.");
        // Cleanup: Xóa file tạm sau khi hoàn tất
        fs.unlink(inputPath, (err) => {
          if (err) console.error("Error deleting input file:", err);
        });
        // fs.unlink(tempPdfPath, (err) => {
        //   if (err) console.error("Error deleting temp PDF file:", err);
        // });

        progress = { completedPages: 0, totalPages: 0 }; // Đặt lại tiến trình sau khi hoàn tất
      });
    });
  } catch (error) {
    console.error("Error during PDF compression:", error);
    return res.status(500).send("Error compressing PDF");
  }
});

const port = 4000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
