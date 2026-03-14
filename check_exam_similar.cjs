
const mongoose = require('mongoose');

const uri = 'mongodb+srv://aiallynk_db_user:AiAllyPass@exammanagement.nuaz42h.mongodb.net/';

async function check() {
    try {
        await mongoose.connect(uri, { dbName: 'exam_system' });

        const Exam = mongoose.model('Exam', new mongoose.Schema({
            uniqueId: String,
            examCode: String,
            title: String,
            examType: String,
            tenantId: mongoose.Schema.Types.ObjectId
        }));

        const exams = await Exam.find({ uniqueId: { $regex: /SLOQ/i } });
        console.log('Exams with SLOQ:', exams.map(e => e.uniqueId));

        const exams2 = await Exam.find({ uniqueId: { $regex: /B6V9/i } });
        console.log('Exams with B6V9:', exams2.map(e => e.uniqueId));

        await mongoose.disconnect();
    } catch (err) {
        console.error('Error:', err);
    }
}

check();
