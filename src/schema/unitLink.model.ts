import mongoose from 'mongoose';

const UnitLinkSchema = new mongoose.Schema({
  contextId: { type: String, required: true, unique: true },
  unitId: { type: String, required: true },
  issuer: { type: String, required: true },
  clientId: { type: String, required: true },
  deploymentId: { type: String, required: true },
  membershipsUrl: { type: String, required: true },
});

const UnitLink = mongoose.model('UnitLink', UnitLinkSchema);

export default UnitLink;
