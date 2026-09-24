/**
 * Outbound email (§6).
 *
 * Drivers:
 *   console — development. Prints the message and stores it in an in-memory
 *             outbox so the demo can surface invitation and reset links.
 *   http    — production-ready generic webhook POST (SES/Postmark/Resend/SMTP
 *             relay). Configure EMAIL_DRIVER=http and EMAIL_HTTP_URL.
 *
 * SECURITY NOTES
 *   - The outbox is exposed ONLY when NODE_ENV !== 'production'. In production
 *     the dev route is not registered at all (see api/dev.routes.ts).
 *   - Templates never include a password, an OTP for a different user, or any
 *     value derived from another tenant.
 *   - Password-reset and verification emails use identical copy whether or not
 *     the address exists, because the decision to send is made by the caller
 *     and the caller always returns the same generic response (§6).
 */
import { config } from '../config.js';

export interface OutboundEmail {
  id: string;
  to: string;
  subject: string;
  subjectAr: string;
  text: string;
  html: string;
  link: string | null;
  kind: string;
  sentAt: string;
}

const OUTBOX_LIMIT = 50;
const outbox: OutboundEmail[] = [];

export function readOutbox(): OutboundEmail[] {
  if (config.env === 'production') return [];
  return [...outbox].reverse();
}

export function clearOutbox(): void {
  outbox.length = 0;
}

export interface SendInput {
  to: string;
  kind: string;
  subject: string;
  subjectAr: string;
  text: string;
  html: string;
  link?: string | null;
}

export async function sendEmail(input: SendInput): Promise<OutboundEmail> {
  const email: OutboundEmail = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    to: input.to,
    subject: input.subject,
    subjectAr: input.subjectAr,
    text: input.text,
    html: input.html,
    link: input.link ?? null,
    kind: input.kind,
    sentAt: new Date().toISOString(),
  };

  outbox.push(email);
  if (outbox.length > OUTBOX_LIMIT) outbox.shift();

  if (config.auth.emailDriver === 'http' && config.auth.emailHttpUrl) {
    try {
      await fetch(config.auth.emailHttpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          to: email.to,
          subject: email.subject,
          text: email.text,
          html: email.html,
        }),
      });
    } catch (err) {
      // Delivery failure must not break the request. The user can retry, and
      // the failure is logged server-side.
      console.error('[email] delivery failed', err instanceof Error ? err.message : err);
    }
    return email;
  }

  if (config.env !== 'test') {
    console.log(
      `\n[email:${email.kind}] → ${email.to}\n` +
        `  ${email.subject}\n` +
        `  ${email.subjectAr}\n` +
        (email.link ? `  link: ${email.link}\n` : ''),
    );
  }
  return email;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
const shell = (bodyAr: string, bodyEn: string) => `<!doctype html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f6f5f1;font-family:'IBM Plex Sans Arabic','Segoe UI',system-ui,sans-serif;color:#12211c">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">
    <div style="background:#0f2b23;color:#fff;padding:20px 24px;border-radius:14px 14px 0 0">
      <div style="font-size:12px;letter-spacing:.18em;color:#c9a227">KGM LEGAL OS</div>
      <div style="font-size:18px;margin-top:4px">بوابة العميل · Client Portal</div>
    </div>
    <div style="background:#fff;padding:28px 24px;border:1px solid #e6e2d8;border-top:0;border-radius:0 0 14px 14px">
      <div dir="rtl" style="line-height:1.9;font-size:15px">${bodyAr}</div>
      <hr style="border:0;border-top:1px solid #eee;margin:22px 0">
      <div dir="ltr" style="line-height:1.7;font-size:14px;color:#4a5a54;text-align:left">${bodyEn}</div>
    </div>
    <p style="text-align:center;color:#8a8578;font-size:12px;margin-top:20px">
      This is an automated message. Please do not reply.<br>
      رسالة آلية، يُرجى عدم الرد.
    </p>
  </div>
</body></html>`;

export const templates = {
  invitation(link: string, displayNameAr: string, firmNameAr: string, firmName: string) {
    return {
      subject: 'Your KGM Client Portal invitation · دعوة بوابة العميل',
      subjectAr: 'دعوة للدخول إلى بوابة العميل',
      link,
      text:
        `مرحباً ${displayNameAr}،\n\n` +
        `تمت دعوتك للوصول إلى بوابة العميل الخاصة بـ ${firmNameAr}.\n` +
        `الرابط: ${link}\n\n` +
        `تنتهي صلاحية الرابط خلال 14 يوماً.\n\n` +
        `---\n` +
        `Hello,\n\nYou have been invited to access the ${firmName} Client Portal.\n` +
        `Link: ${link}\n\nThis link expires in 14 days.`,
      html: shell(
        `<p>مرحباً <strong>${displayNameAr}</strong>،</p>
         <p>تمت دعوتك للوصول إلى بوابة العميل الخاصة بـ <strong>${firmNameAr}</strong>.</p>
         <p style="margin:24px 0">
           <a href="${link}" style="display:inline-block;background:#0f2b23;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px">
             قبول الدعوة وتفعيل الحساب</a>
         </p>
         <p style="color:#6b7a74;font-size:13px">تنتهي صلاحية هذا الرابط خلال 14 يوماً. إذا لم تطلب هذه الدعوة، يمكنك تجاهل هذا البريد بأمان.</p>`,
        `<p>You have been invited to access the <strong>${firmName}</strong> Client Portal.</p>
         <p>Use the button above to accept the invitation and create your password. This link expires in 14 days.</p>
         <p style="color:#6b7a74;font-size:13px">If you did not expect this invitation, you can safely ignore this email. No account will be created.</p>`,
      ),
    };
  },

  passwordReset(link: string) {
    return {
      subject: 'Reset your password · إعادة تعيين كلمة المرور',
      subjectAr: 'إعادة تعيين كلمة المرور',
      link,
      text:
        `لقد طلبنا إعادة تعيين كلمة المرور لبوابة العميل.\n` +
        `الرابط: ${link}\n\n` +
        `تنتهي الصلاحية خلال 30 دقيقة. إذا لم تطلب ذلك، تجاهل هذا البريد.\n\n---\n` +
        `We received a request to reset your Client Portal password.\nLink: ${link}\n` +
        `It expires in 30 minutes. If you did not request this, ignore this email.`,
      html: shell(
        `<p>لقد استلمنا طلباً لإعادة تعيين كلمة المرور الخاصة ببوابة العميل.</p>
         <p style="margin:24px 0"><a href="${link}" style="display:inline-block;background:#0f2b23;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px">إعادة تعيين كلمة المرور</a></p>
         <p style="color:#6b7a74;font-size:13px">تنتهي صلاحية هذا الرابط خلال 30 دقيقة ولا يمكن استخدامه إلا مرة واحدة. إذا لم تطلب ذلك، تجاهل هذا البريد؛ لن يتم تغيير أي شيء.</p>`,
        `<p>We received a request to reset your Client Portal password.</p>
         <p style="color:#6b7a74;font-size:13px">This link expires in 30 minutes and can only be used once. If you did not request it, ignore this email — nothing will change.</p>`,
      ),
    };
  },

  verifyEmail(link: string) {
    return {
      subject: 'Verify your email · تأكيد البريد الإلكتروني',
      subjectAr: 'تأكيد البريد الإلكتروني',
      link,
      text:
        `يُرجى تأكيد بريدك الإلكتروني للوصول إلى بوابة العميل.\nالرابط: ${link}\n\n---\n` +
        `Please verify your email address to access the Client Portal.\nLink: ${link}`,
      html: shell(
        `<p>يُرجى تأكيد بريدك الإلكتروني لإكمال تفعيل حسابك في بوابة العميل.</p>
         <p style="margin:24px 0"><a href="${link}" style="display:inline-block;background:#0f2b23;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px">تأكيد البريد الإلكتروني</a></p>`,
        `<p>Please confirm your email address to finish activating your Client Portal account.</p>`,
      ),
    };
  },

  otp(code: string, purposeAr: string, purposeEn: string) {
    return {
      subject: `Your verification code · ${code}`,
      subjectAr: `رمز التحقق الخاص بك · ${code}`,
      link: null,
      text:
        `${purposeAr}\n\nرمز التحقق: ${code}\n\nتنتهي صلاحيته خلال 10 دقائق.\n---\n` +
        `${purposeEn}\n\nYour verification code is ${code}. It expires in 10 minutes.`,
      html: shell(
        `<p>${purposeAr}</p>
         <p style="font-size:34px;letter-spacing:.35em;text-align:center;background:#f4f2ec;padding:20px;border-radius:12px;margin:22px 0;direction:ltr">${code}</p>
         <p style="color:#6b7a74;font-size:13px">تنتهي صلاحية الرمز خلال 10 دقائق. لا تشاركه مع أي شخص؛ لن يطلبه منك موظفو الشركة أبداً.</p>`,
        `<p>${purposeEn}</p>
         <p style="color:#6b7a74;font-size:13px">The code expires in 10 minutes. Never share it — staff will never ask you for it.</p>`,
      ),
    };
  },

  securityAlert(titleAr: string, bodyAr: string, titleEn: string, bodyEn: string) {
    return {
      subject: `Security notice · ${titleEn}`,
      subjectAr: `إشعار أمني · ${titleAr}`,
      link: null,
      text: `${titleAr}\n${bodyAr}\n---\n${titleEn}\n${bodyEn}`,
      html: shell(
        `<p><strong>${titleAr}</strong></p><p>${bodyAr}</p>
         <p style="color:#6b7a74;font-size:13px">إذا لم تكن أنت، يُرجى تغيير كلمة المرور فوراً من مركز الأمان في بوابة العميل.</p>`,
        `<p><strong>${titleEn}</strong></p><p>${bodyEn}</p>
         <p style="color:#6b7a74;font-size:13px">If this was not you, change your password immediately from the Security centre.</p>`,
      ),
    };
  },
};
