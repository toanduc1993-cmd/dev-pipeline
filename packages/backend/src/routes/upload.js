import { Router } from 'express';
import { upload, extractText } from '../services/fileService.js';
import { asyncWrap } from '../middleware/asyncWrap.js';

const router = Router();

router.post(
  '/',
  upload.single('file'),
  asyncWrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { extractedText } = await extractText(req.file.path);
    res.json({
      filePath: req.file.path,
      originalName: req.file.originalname,
      size: req.file.size,
      extractedText,
    });
  })
);

export default router;
