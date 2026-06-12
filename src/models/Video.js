import mongoose from 'mongoose';

const videoSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  originalFileName: String,
  originalPath: String,
  originalSize: Number,
  duration: Number,
  originalResolution: String,

  status: {
    type: String,
    enum: ['uploaded', 'processing', 'completed', 'failed'],
    default: 'uploaded'
  },
  progress: {
    type: Number,
    default: 0
  },

  availableQualities: [String], // ['original', '1080p', '720p']
  hlsMasterPath: String,
  thumbnailPath: String,
  previewVttPath: String,

  is720pReady: { type: Boolean, default: false },
  is1080pReady: { type: Boolean, default: false },

  errorMessage: String
}, {
  timestamps: true
});

const Video = mongoose.model('Video', videoSchema);

export default Video;
