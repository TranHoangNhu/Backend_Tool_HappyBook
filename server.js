const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const { exec } = require("child_process");
const PDFParser = require("pdf-parse");

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
  const outputPath = path.resolve(
    "uploads",
    `compressed_${req.file.originalname.replace(/[^a-zA-Z0-9]/g, "_")}.pdf`
  );

  const { colorImageDPI, grayImageDPI, monoImageDPI, jpegQuality } = req.body;

  // Đọc số trang của PDF
  try {
    const dataBuffer = fs.readFileSync(inputPath);
    const pdfData = await PDFParser(dataBuffer);
    progress.totalPages = pdfData.numpages;
  } catch (err) {
    console.error("Error reading PDF:", err);
    return res.status(500).send("Error reading PDF");
  }

  try {
    // Lệnh Ghostscript nén file PDF với tùy chọn tùy chỉnh
    const command = `"C:/Program Files/gs/gs10.04.0/bin/gswin64c.exe" -sDEVICE=pdfwrite \
       -dCompatibilityLevel=1.4 \
       -dPDFSETTINGS=/screen \
       -dNOPAUSE -dBATCH \
       -dDownsampleColorImages=true -dColorImageResolution=${colorImageDPI} \
       -dDownsampleGrayImages=true -dGrayImageResolution=${grayImageDPI} \
       -dDownsampleMonoImages=true -dMonoImageResolution=${monoImageDPI} \
       -dJPEGQ=${jpegQuality} \
       -sOutputFile="${outputPath}" "${inputPath}"`;

    console.log("Running command:", command);

    progress.completedPages = 0;

    // Thực thi lệnh Ghostscript và theo dõi tiến trình
    const gsProcess = exec(command);

    gsProcess.stdout.on("data", (data) => {
      // Giả lập cập nhật tiến trình dựa trên stdout (tùy thuộc vào thông tin từ Ghostscript)
      if (data.includes("Page")) {
        const match = data.match(/Page\s+(\d+)/);
        if (match) {
          const currentPage = parseInt(match[1], 10);
          if (!isNaN(currentPage) && progress.totalPages > 0) {
            progress.completedPages = currentPage;
          }
        }
      }
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

            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
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
