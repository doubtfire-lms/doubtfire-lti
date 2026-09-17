import mongoose from 'mongoose';

const MoodleCourseConnectionSchema = new mongoose.Schema(
  {
    contextId: { type: String, required: true, unique: true },
    contextLabel: { type: String },
    contextTitle: { type: String },
    platformId: { type: String, required: true },
    endpoint: { type: String, required: true },
    scope: { type: String, required: true },
    selectedAssignmentId: { type: String },
    selectedAssignmentName: { type: String },
    lastFetchedAt: { type: Date },
  },
  { timestamps: true },
);

const MoodleCourseConnection = mongoose.model(
  'MoodleCourseConnection',
  MoodleCourseConnectionSchema,
);

export default MoodleCourseConnection;
