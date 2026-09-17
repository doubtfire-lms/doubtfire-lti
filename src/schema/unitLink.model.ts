import mongoose from 'mongoose';

const UnitLinkSchema = new mongoose.Schema(
  {
    contextId: { type: String, required: true, unique: true },
    // A unit can only be linked to one LMS course.
    unitId: { type: String, required: true, unique: true },
    lineItemId: { type: String },

    // Service details captured from signed launches so OnTrack can reach the LMS without a launch.
    platformId: { type: String },
    contextLabel: { type: String },
    contextTitle: { type: String },
    membershipsUrl: { type: String },
    courseDataEndpoint: { type: String },
    courseDataScope: { type: String },
    courseDataAvailable: { type: Boolean, default: false },
    capabilitiesCheckedAt: { type: Date },
  },
  { timestamps: true },
);

const UnitLink = mongoose.model('UnitLink', UnitLinkSchema);

export type UnitLinkDocument = InstanceType<typeof UnitLink>;

export default UnitLink;
