const nodemailer = require('nodemailer');

// ตั้งค่า transporter (ใช้ Gmail หรือบริการอื่น)
const transporter = nodemailer.createTransport({
  service: 'gmail', // หรือ 'hotmail', 'yahoo' หรือ SMTP อื่น
        auth: {
        user: 'jopizz1112@gmail.com',
        pass: 'nkjr onnr ztod vqkp'               // ← ตรงนี้ยังเป็นรหัสผ่านปกติหรือคัดลอกผิด
        }
});

const sendResetPasswordEmail = async (email, resetToken, req) => {
  const resetUrl = `${req.protocol}://${req.get('host')}/reset-password/${resetToken}`;

  const mailOptions = {
    from: '"ระบบจัดการแข่งมวย" <your-email@gmail.com>',
    to: email,
    subject: 'รีเซ็ตรหัสผ่าน - ระบบจัดการแข่งมวย',
    html: `
      <h2>คุณขอรีเซ็ตรหัสผ่าน</h2>
      <p>คลิกลิงก์ด้านล่างเพื่อตั้งรหัสผ่านใหม่ (ลิงก์ใช้ได้ 1 ชั่วโมง):</p>
      <a href="${resetUrl}" style="background:#3b82f6;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">
        ตั้งรหัสผ่านใหม่
      </a>
      <p>หากคุณไม่ได้ขอรีเซ็ต กรุณาเพิกเฉยอีเมลนี้</p>
      <p>ขอบคุณครับ</p>
    `
  };

  await transporter.sendMail(mailOptions);
};

module.exports = { sendResetPasswordEmail };