const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const archiver = require('archiver');
const { PassThrough } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

// ミドルウェア設定
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 一時ファイルディレクトリ
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// FFmpegのパス設定（必要に応じて変更）
// ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');

// 定期的な一時ファイルクリーンアップ（1時間ごと）
setInterval(() => {
  const now = Date.now();
  fs.readdir(TEMP_DIR, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        // 1時間以上経過したファイルを削除
        if (now - stats.mtimeMs > 3600000) {
          fs.unlink(filePath, () => {});
        }
      });
    });
  });
}, 3600000);

// 動画情報取得API
app.post('/api/info', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url || !ytdl.validateURL(url)) {
      return res.status(400).json({ error: '無効なYouTube URLです' });
    }

    const info = await ytdl.getInfo(url);
    
    const videoInfo = {
      title: info.videoDetails.title,
      channel: info.videoDetails.author.name,
      duration: info.videoDetails.lengthSeconds,
      thumbnail: info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1].url,
      formats: info.formats
        .filter(format => format.hasAudio && !format.hasVideo)
        .map(format => ({
          itag: format.itag,
          container: format.container,
          codecs: format.codecs,
          audioBitrate: format.audioBitrate,
          audioQuality: format.audioQuality
        }))
    };

    res.json(videoInfo);
  } catch (error) {
    console.error('動画情報取得エラー:', error);
    res.status(500).json({ error: '動画情報の取得に失敗しました' });
  }
});

// M4A変換・ダウンロードAPI
app.post('/api/convert', async (req, res) => {
  const { url, format = 'm4a', quality = 'highest' } = req.body;
  
  if (!url || !ytdl.validateURL(url)) {
    return res.status(400).json({ error: '無効なYouTube URLです' });
  }

  const jobId = uuidv4();
  const outputPath = path.join(TEMP_DIR, `${jobId}.${format}`);
  
  try {
    const info = await ytdl.getInfo(url);
    const title = info.videoDetails.title.replace(/[^\w\s\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g, '');
    
    // 音声ストリームの選択
    const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');
    let selectedFormat;
    
    if (quality === 'highest') {
      selectedFormat = audioFormats.sort((a, b) => b.audioBitrate - a.audioBitrate)[0];
    } else {
      selectedFormat = audioFormats.sort((a, b) => a.audioBitrate - b.audioBitrate)[0];
    }

    // ダウンロードストリーム
    const audioStream = ytdl.downloadFromInfo(info, { format: selectedFormat });
    
    // FFmpeg変換
    const convertStream = ffmpeg(audioStream)
      .audioCodec(format === 'm4a' ? 'aac' : format === 'mp3' ? 'libmp3lame' : 'copy')
      .audioBitrate(selectedFormat.audioBitrate)
      .format(format)
      .on('progress', (progress) => {
        console.log(`変換進捗 (${jobId}): ${progress.percent}%`);
        // プログレスはSSEでクライアントに送信可能
      })
      .on('error', (err) => {
        console.error('FFmpeg変換エラー:', err);
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
      });

    // ファイルに保存
    const writeStream = fs.createWriteStream(outputPath);
    
    convertStream.pipe(writeStream);

    writeStream.on('finish', () => {
      // ダウンロードレスポンス
      res.setHeader('Content-Type', `audio/${format === 'm4a' ? 'mp4' : format}`);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(title)}.${format}`);
      
      const readStream = fs.createReadStream(outputPath);
      readStream.pipe(res);
      
      readStream.on('end', () => {
        // ダウンロード完了後にファイル削除
        fs.unlink(outputPath, () => {});
      });
      
      readStream.on('error', () => {
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
        res.status(500).end();
      });
    });

    writeStream.on('error', (err) => {
      console.error('ファイル書き込みエラー:', err);
      res.status(500).json({ error: 'ファイルの書き込みに失敗しました' });
    });

    // クライアントが切断した場合の処理
    req.on('close', () => {
      audioStream.destroy();
      convertStream.destroy();
      writeStream.destroy();
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
    });

  } catch (error) {
    console.error('変換エラー:', error);
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    res.status(500).json({ error: '変換に失敗しました' });
  }
});

// プログレス監視用のストリーミングAPI
app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // 実際のプログレス監視ロジック
  const interval = setInterval(() => {
    res.write(`data: ${JSON.stringify({ progress: 50 })}\n\n`);
  }, 1000);
  
  req.on('close', () => {
    clearInterval(interval);
  });
});

// ヘルスチェック
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// エラーハンドリング
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'サーバーエラーが発生しました' });
});

app.listen(PORT, () => {
  console.log(`サーバー起動中: http://localhost:${PORT}`);
  console.log(`FFmpegパス: ${ffmpeg().getFfmpegPath()}`);
});
