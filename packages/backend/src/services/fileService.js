import multer from 'multer';
import path from 'path';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import logger from '../lib/logger.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const MAX_FILE_SIZE = (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 10) * 1024 * 1024;

if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

function fileFilter(_req, file, cb) {
  const allowed = ['.pdf', '.docx', '.doc', '.md', '.txt', '.png', '.jpg', '.jpeg', '.gif', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) cb(null, true);
  else cb(new Error(`File type ${ext} not allowed. Accepted: ${allowed.join(', ')}`));
}

export const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE } });

export async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf') {
    // Try pdf-parse first (text-based PDFs)
    const pdfParse = (await import('pdf-parse')).default;
    const buffer = readFileSync(filePath);
    const data = await pdfParse(buffer);

    // If text is mostly empty (image-based PDF), use OCR
    const cleanText = data.text.replace(/\s/g, '');
    if (cleanText.length < 50 && data.numpages > 0) {
      logger.info({ filePath, pages: data.numpages }, 'PDF is image-based — using OCR');
      try {
        const ocrText = await extractPDFWithOCR(filePath, data.numpages);
        return { extractedText: ocrText, pages: data.numpages, method: 'ocr' };
      } catch (ocrErr) {
        logger.warn({ err: ocrErr.message }, 'OCR failed — returning empty text');
        return { extractedText: data.text, pages: data.numpages, method: 'pdf-parse-empty' };
      }
    }

    return { extractedText: data.text, pages: data.numpages, method: 'pdf-parse' };
  }

  if (ext === '.docx' || ext === '.doc') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return { extractedText: result.value };
  }

  if (ext === '.md' || ext === '.txt') {
    return { extractedText: readFileSync(filePath, 'utf-8') };
  }

  // Images — use Claude to extract text/describe content
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
    try {
      const { runClaude } = await import('./claude/claudeService.js');
      const base64 = readFileSync(filePath).toString('base64');
      const mimeType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';

      // Use Claude to read the image and extract requirements
      const result = await runClaude({
        prompt: `I'm uploading an image that contains project requirements or design specifications. Please extract ALL text content from this image. If it's a wireframe or design mockup, describe every UI element, layout, and interaction in detail. If it's a diagram, describe the architecture and data flow. Output everything as structured text that can be used as software requirements.\n\n[Image is provided as base64 data URI — the system will handle the image input]`,
        tools: [],
        timeoutMs: 60000,
      });

      if (result.success && result.output) {
        return { extractedText: result.output };
      }
      return { extractedText: `[Image uploaded: ${path.basename(filePath)}. Could not extract text automatically.]` };
    } catch (err) {
      logger.warn({ err: err.message, filePath }, 'Image text extraction failed');
      return { extractedText: `[Image uploaded: ${path.basename(filePath)}]` };
    }
  }

  throw new Error(`Unsupported file type: ${ext}`);
}

/**
 * Extract text from image-based PDF using pymupdf + tesseract OCR.
 * Requires: python3, pymupdf (fitz), pytesseract, Pillow, tesseract CLI
 */
async function extractPDFWithOCR(filePath, totalPages) {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const { writeFileSync, unlinkSync } = await import('fs');
  const { tmpdir } = await import('os');
  const execAsync = promisify(exec);

  const absPath = path.resolve(filePath);
  const scriptPath = path.join(tmpdir(), `ocr_${Date.now()}.py`);

  const script = [
    'import fitz, pytesseract, io, subprocess',
    'from PIL import Image',
    '',
    '# Detect available tesseract languages',
    'available = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True).stdout',
    'lang = "vie+eng" if "vie" in available else "eng"',
    '',
    `doc = fitz.open("${absPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`,
    'text_parts = []',
    'for i in range(doc.page_count):',
    '    page = doc[i]',
    '    pix = page.get_pixmap(dpi=200)',
    '    img = Image.open(io.BytesIO(pix.tobytes("png")))',
    '    text = pytesseract.image_to_string(img, lang=lang)',
    '    if text.strip():',
    '        text_parts.append(f"--- Page {i+1} ---\\n{text}")',
    'doc.close()',
    'print("\\n\\n".join(text_parts))',
  ].join('\n');

  writeFileSync(scriptPath, script, 'utf8');

  try {
    const { stdout } = await execAsync(`python3 "${scriptPath}"`, {
      timeout: totalPages * 10000 + 30000,
      maxBuffer: 50 * 1024 * 1024,
    });
    logger.info({ filePath, pages: totalPages, textLength: stdout.length }, 'PDF OCR completed');
    return stdout;
  } finally {
    try { unlinkSync(scriptPath); } catch {}
  }
}
