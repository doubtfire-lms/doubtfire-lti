import mongoose from 'mongoose';

const UnitLinkSchema = new mongoose.Schema({
  contextId: { type: String, required: true, unique: true },
  unitId: { type: String, required: true },
});

const UnitLink = mongoose.model('UnitLink', UnitLinkSchema);

export default UnitLink;
