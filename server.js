const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const { exec } = require("child_process");
const muhammara = require("muhammara"); // Thay thế HummusJS bằng MuhammaraJS
const { convert } = require("pdf-poppler"); // Dùng để chuyển PDF thành ảnh

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
  const outputPath = path.resolve(
    "uploads",
    `compressed_${req.file.originalname.replace(/[^a-zA-Z0-9]/g, "_")}.pdf`
  );

  try {
    // Đọc PDF và chuyển mỗi trang thành hình ảnh
    const options = {
      format: "jpeg",
      out_dir: "uploads",
      out_prefix: path.basename(inputPath, path.extname(inputPath)),
      page: null,
    };

    let totalPages = 0;
    const pdfInfo = await convert(inputPath, options).catch((error) => {
      console.error("Error converting PDF to images:", error);
      throw error;
    });
    totalPages = pdfInfo.length;
    progress.totalPages = totalPages;

    // Tạo một file PDF mới từ các hình ảnh đã nén bằng MuhammaraJS
    const pdfWriter = muhammara.createWriter(tempPdfPath);

    for (let page = 1; page <= totalPages; page++) {
      progress.completedPages = page;
      const imgPath = path.resolve(
        "uploads",
        `${options.out_prefix}-${page}.jpg`
      );

      // Thêm hình ảnh đã chuyển đổi vào tài liệu PDF
      if (fs.existsSync(imgPath)) {
        const pageDimensions = { width: 595.28, height: 841.89 }; // Kích thước chuẩn A4
        const pageContext = pdfWriter.createPage(
          0,
          0,
          pageDimensions.width,
          pageDimensions.height
        );
        const context = pdfWriter.startPageContentContext(pageContext);
        context.drawImage(0, 0, imgPath, {
          transformation: {
            width: pageDimensions.width,
            height: pageDimensions.height,
          },
        });
        pdfWriter.writePage(pageContext);
      } else {
        console.error(`Image file not found: ${imgPath}`);
      }
    }

    pdfWriter.end();

    console.log("Image-based PDF created, running Ghostscript...");

    // Nén PDF bằng Ghostscript
    const command = `"C:/Program Files/gs/gs10.04.0/bin/gswin64c.exe" -sDEVICE=pdfwrite \
      -dCompatibilityLevel=1.4 \
      -dPDFSETTINGS=/screen \
      -dNOPAUSE -dBATCH \
      -dDownsampleColorImages=true -dColorImageResolution=72 \
      -dDownsampleGrayImages=true -dGrayImageResolution=72 \
      -dDownsampleMonoImages=true -dMonoImageResolution=72 \
      -dJPEGQ=75 \
      -sOutputFile="${outputPath}" "${tempPdfPath}"`;

    console.log("Running command:", command);

    const gsProcess = exec(command);

    gsProcess.stdout.on("data", (data) => {
      console.log(data);
    });

    gsProcess.on("exit", (code) => {
      if (code === 0) {
        console.log("Compression finished, checking output...");
        fs.access(outputPath, fs.constants.F_OK, (err) => {
          if (err) {
            console.error("Compressed file not found:", outputPath);
            return res.status(404).send("Compressed file not found");
          }

          // Gửi file nén cho client
          res.download(outputPath, (err) => {
            if (err) {
              console.error("Error during download:", err);
              return res.status(500).send("Error downloading compressed PDF");
            }

            // Cleanup: Xóa file tạm sau khi hoàn tất
            fs.unlink(inputPath, (err) => {
              if (err) console.error("Error deleting input file:", err);
            });
            fs.unlink(tempPdfPath, (err) => {
              if (err) console.error("Error deleting temp PDF file:", err);
            });
            // fs.unlink(outputPath, (err) => {
            //   if (err) console.error("Error deleting output file:", err);
            // });

            progress = { completedPages: 0, totalPages: 0 }; // Đặt lại tiến trình sau khi hoàn tất
          });
        });
      } else {
        console.error("Ghostscript exited with code:", code);
        progress = { completedPages: 0, totalPages: 0 };
        res.status(500).send("Error compressing PDF");
      }
    });
  } catch (error) {
    console.error("Error during PDF compression:", error);
    res.status(500).send("Error compressing PDF");
  }
});

const port = 4000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
