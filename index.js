import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  normalizeMessageContent
} from '@whiskeysockets/baileys'

import { GoogleGenerativeAI } from '@google/generative-ai'
import pino from 'pino'
import fs from 'fs'
import path from 'path'

const AUTH_DIR = process.env.AUTH_DIR || './auth'
const DATA_DIR = process.env.DATA_DIR || './data'
const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || './knowledge'
const PROMPT_FILE = './prompts/teacher.txt'
const USERS_FILE = path.join(DATA_DIR, 'users.json')

const PHONE = (process.env.PHONE || '').replace(/[^0-9]/g, '')
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || 'gemini-3-flash-preview'

const logger = pino({ level: 'silent' })
const users = new Map()
const knowledge = []
let teacherPrompt = ''

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms))

const SUBJECTS = [
  'الرياضيات',
  'الفيزياء والكيمياء',
  'علوم الحياة والأرض',
  'اللغة العربية',
  'اللغة الفرنسية',
  'الاجتماعيات',
  'التاريخ',
  'الجغرافيا',
  'التربية على المواطنة',
  'التربية الإسلامية'
]

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .trim()
}

function ensureFolders() {
  fs.mkdirSync(AUTH_DIR, { recursive: true })
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true })
  fs.mkdirSync('./prompts', { recursive: true })

  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, '{}', 'utf8')
  }
}

function loadTeacherPrompt() {
  try {
    teacherPrompt = fs.readFileSync(
      PROMPT_FILE,
      'utf8'
    ).trim()

    console.log('Teacher prompt loaded')
  } catch (error) {
    teacherPrompt = `
أنت مساعد دراسي مغربي من تطوير المبرمج مروان.
أنت مخصص لجميع مواد الثالثة إعدادي.
اشرح بطريقة بسيطة، وفسر دائماً علاش وكيفاش.
`
    console.log(
      'PROMPT LOAD ERROR:',
      error.message
    )
  }
}

function loadUsers() {
  try {
    const saved = JSON.parse(
      fs.readFileSync(
        USERS_FILE,
        'utf8'
      )
    )

    for (
      const [id, user]
      of Object.entries(saved)
    ) {
      users.set(id, user)
    }
  } catch (error) {
    console.log(
      'USERS LOAD ERROR:',
      error.message
    )
  }
}

function saveUsers() {
  fs.writeFileSync(
    USERS_FILE,
    JSON.stringify(
      Object.fromEntries(users),
      null,
      2
    ),
    'utf8'
  )
}

function getUser(id) {
  if (!users.has(id)) {
    users.set(id, {
      level: 'الثالثة إعدادي',
      subject: null,
      history: []
    })
  }

  return users.get(id)
}

function getContent(message) {
  return (
    normalizeMessageContent(
      message.message
    ) || message.message
  )
}

function getText(content) {
  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.documentMessage?.caption ||
    ''
  ).trim()
}

function walk(dir) {
  const result = []

  for (
    const item of fs.readdirSync(
      dir,
      { withFileTypes: true }
    )
  ) {
    const full = path.join(dir, item.name)

    if (item.isDirectory()) {
      result.push(...walk(full))
    } else {
      result.push(full)
    }
  }

  return result
}

function loadKnowledge() {
  knowledge.length = 0

  const files = walk(KNOWLEDGE_DIR)

  for (const file of files) {
    const extension =
      path.extname(file).toLowerCase()

    if (
      ![
        '.txt',
        '.md',
        '.json',
        '.csv'
      ].includes(extension)
    ) {
      continue
    }

    try {
      const text =
        fs.readFileSync(
          file,
          'utf8'
        )
        .replace(/\s+/g, ' ')
        .trim()

      if (!text) continue

      for (
        let start = 0;
        start < text.length;
        start += 1600
      ) {
        const part =
          text
            .slice(start, start + 1800)
            .trim()

        if (part.length > 80) {
          knowledge.push({
            file: path.relative(
              KNOWLEDGE_DIR,
              file
            ),
            text: part
          })
        }
      }
    } catch (error) {
      console.log(
        'KNOWLEDGE ERROR:',
        file,
        error.message
      )
    }
  }

  console.log(
    `Knowledge loaded: ${knowledge.length} chunks from ${files.length} files`
  )
}

function findKnowledge(question, subject) {
  const words =
    normalize(question)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(word => word.length > 2)

  return knowledge
    .map(item => {
      const searchable =
        normalize(
          `${item.file} ${item.text}`
        )

      let score = 0

      for (const word of words) {
        if (searchable.includes(word)) {
          score += 2
        }
      }

      if (
        subject &&
        searchable.includes(
          normalize(subject)
        )
      ) {
        score += 5
      }

      return {
        ...item,
        score
      }
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
}

function casualReply(text) {
  const value = normalize(text)

  if (
    [
      'سلام',
      'سلام عليكم',
      'السلام عليكم',
      'salam',
      'hello',
      'hi'
    ].includes(value)
  ) {
    return (
      'وعليكم السلام، مرحبا بك. ' +
      'أنا المساعد الدراسي من تطوير مروان. ' +
      'كيف نقدر نعاونك اليوم؟'
    )
  }

  if (
    value.includes('لباس') ||
    value.includes('لاباس') ||
    value.includes('كيداير') ||
    value.includes('كيف داير')
  ) {
    return (
      'الحمد لله بخير، شكرا على السؤال. ' +
      'ونتا لباس؟ بغيتي نشرح ليك شي درس ديال الثالثة إعدادي؟'
    )
  }

  if (
    value.includes('شكرا') ||
    value.includes('مرسي')
  ) {
    return (
      'بلا جميل، أنا هنا باش نعاونك تفهم الدرس مزيان.'
    )
  }

  if (
    value.includes('شكون نتا') ||
    value.includes('من نتا') ||
    value.includes('شنو كتدير')
  ) {
    return (
      'أنا مساعد دراسي من تطوير مروان، ' +
      'كنعاون تلاميذ الثالثة إعدادي يفهمو الدروس خطوة بخطوة.'
    )
  }

  return null
}

function detectSubject(text) {
  const value = normalize(text)

  return (
    SUBJECTS.find(subject =>
      value.includes(
        normalize(subject)
      )
    ) || null
  )
}

function buildSystemInstruction(
  user,
  context
) {
  return `
${teacherPrompt}

أنت مساعد دراسي مغربي ذكي من تطوير المبرمج مروان.
أنت مخصص لجميع مواد الثالثة إعدادي فقط.
المادة الحالية هي:
${user.subject || 'غير محددة'}

لا تقل إنك مروان.
قل فقط إنك مساعد دراسي من تطوير مروان عند الحاجة.

أنت مربي قريب من التلميذ، ماشي أستاذ جاف.
استعمل دارجة مغربية مبسطة ومفهومة مع عربية فصحى سهلة.

طبق هذه القواعد دائماً:

- لا تعط جواباً ناشفاً أو معلومة محفوظة فقط.
- اشرح دائماً علاش وكيفاش.
- في التاريخ اشرح الأسباب والنتائج والعلاقة بين الأحداث.
- في الجغرافيا اشرح العلاقة بين الظواهر والمعطيات.
- في الرياضيات والعلوم اشرح القاعدة وسبب استعمالها.
- في اللغات اشرح القواعد والأخطاء بأمثلة.
- استعمل أمثلة وتشبيهات من الحياة اليومية لتقريب المفاهيم.
- بسط الشرح حسب مستوى الثالثة إعدادي مع الحفاظ على الدقة.
- لا تعط الحل النهائي مباشرة إذا كان التلميذ يحتاج أن يتعلم.
- خدم مع التلميذ خطوة بخطوة.
- قسم الدرس إلى مراحل قصيرة.
- في نهاية كل مرحلة اطرح سؤال فهم واحداً.
- إذا قال ما فهمتش، استعمل شرحاً ومثالاً جديدين.
- إذا قال فهمت، تابع للمرحلة التالية.
- لا تخترع أرقاماً أو تواريخ أو مراجع.
- إذا كانت الصورة غير واضحة، قل ذلك ولا تخمن.

عندما يطلب التلميذ شرح درس:
1. قدم الفكرة العامة.
2. اشرح المتطلبات السابقة.
3. اشرح المفاهيم.
4. أعط مثالاً بسيطاً.
5. أعط مثالاً محلولاً مع تفسير علاش.
6. قدم خلاصة قصيرة.
7. أعط تمريناً صغيراً.

مراجع الدروس:
${context || 'لا توجد مراجع مناسبة حالياً.'}
`
}

async function askGemini(
  user,
  question,
  imageBuffer = null,
  mimeType = 'image/jpeg'
) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY ناقص في Railway Variables.'
    )
  }

  const found =
    findKnowledge(
      question,
      user.subject
    )

  const context =
    found
      .map((item, index) =>
        `[مرجع ${index + 1}: ${item.file}]\n${item.text}`
      )
      .join('\n\n')

  const genAI =
    new GoogleGenerativeAI(
      GEMINI_API_KEY
    )

  const model =
    genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction:
        buildSystemInstruction(
          user,
          context
        )
    })

  const previous =
    (user.history || []).slice(-8)

  const historyText =
    previous.length
      ? '\nسياق الحديث السابق:\n' +
        previous
          .map(item =>
            `${item.role}: ${item.content}`
          )
          .join('\n')
      : ''

  const parts = [
    {
      text: question + historyText
    }
  ]

  if (imageBuffer) {
    parts.push({
      inlineData: {
        data: imageBuffer.toString(
          'base64'
        ),
        mimeType
      }
    })
  }

  const result =
    await model.generateContent({
      contents: [
        {
          role: 'user',
          parts
        }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2500
      }
    })

  const answer =
    result.response.text().trim()

  if (!answer) {
    throw new Error(
      'Gemini ما رجع حتى جواب.'
    )
  }

  user.history = [
    ...(user.history || []),
    {
      role: 'user',
      content:
        question || '[صورة تمرين]'
    },
    {
      role: 'assistant',
      content: answer
    }
  ].slice(-10)

  saveUsers()

  return answer
}

function helpText() {
  return `
مرحبا بك في المساعد الدراسي من تطوير مروان.

أنا مخصص لجميع مواد الثالثة إعدادي.

المواد:
- الرياضيات
- الفيزياء والكيمياء
- علوم الحياة والأرض
- اللغة العربية
- اللغة الفرنسية
- الاجتماعيات
- التاريخ
- الجغرافيا
- التربية على المواطنة
- التربية الإسلامية

كتب مثلاً:
مادة الرياضيات
أو:
مادة الاجتماعيات

ومن بعد كتب اسم الدرس أو صيفط صورة تمرين.

الأوامر:
help
reset
`
}

async function start() {
  ensureFolders()
  loadTeacherPrompt()
  loadUsers()
  loadKnowledge()

  if (!GEMINI_API_KEY) {
    console.log(
      'WARNING: GEMINI_API_KEY ناقصة.'
    )
  }

  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(
    AUTH_DIR
  )

  const {
    version
  } = await fetchLatestBaileysVersion()

  const sock =
    makeWASocket({
      version,
      auth: state,
      logger
    })

  let pairingRequested = false

  sock.ev.on(
    'creds.update',
    saveCreds
  )

  sock.ev.on(
    'connection.update',
    async ({
      connection,
      lastDisconnect,
      qr
    }) => {
      if (
        qr &&
        !pairingRequested &&
        !state.creds.registered &&
        PHONE
      ) {
        pairingRequested = true

        try {
          const code =
            await sock.requestPairingCode(
              PHONE
            )

          console.log(
            'PAIRING CODE:',
            code
          )
        } catch (error) {
          console.log(
            'PAIRING ERROR:',
            error.message
          )

          pairingRequested = false
        }
      }

      if (connection === 'open') {
        console.log(
          'Marouane 3AC Gemini bot connected'
        )
      }

      if (connection === 'close') {
        const code =
          lastDisconnect
            ?.error
            ?.output
            ?.statusCode

        console.log(
          'Connection closed, code:',
          code
        )

        if (
          code !== DisconnectReason.loggedOut
        ) {
          await sleep(3000)
          start()
        } else {
          console.log(
            'Logged out. Delete auth volume and relink.'
          )
        }
      }
    }
  )

  sock.ev.on(
    'messages.upsert',
    async ({ messages }) => {
      for (const message of messages) {
        try {
          if (
            !message.message ||
            message.key.fromMe
          ) {
            continue
          }

          const chatId =
            message.key.remoteJid

          if (
            !chatId ||
            chatId.endsWith('@g.us')
          ) {
            continue
          }

          const content =
            getContent(message)

          const text =
            getText(content)

          const lower =
            normalize(text)

          const user =
            getUser(chatId)

          if (
            lower === 'help' ||
            lower === 'مساعدة'
          ) {
            await sock.sendMessage(
              chatId,
              {
                text: helpText()
              }
            )

            continue
          }

          if (
            lower === 'reset' ||
            lower === 'مسح'
          ) {
            users.delete(chatId)
            saveUsers()

            await sock.sendMessage(
              chatId,
              {
                text:
                  'تم مسح الذاكرة. كتب المادة من جديد.'
              }
            )

            continue
          }

          const smallTalk =
            casualReply(text)

          if (smallTalk) {
            await sock.sendMessage(
              chatId,
              {
                text: smallTalk
              }
            )

            continue
          }

          const subject =
            detectSubject(text)

          if (
            subject &&
            (
              lower.startsWith('مادة') ||
              text.length < 35
            )
          ) {
            user.subject = subject
            user.history = []

            saveUsers()

            await sock.sendMessage(
              chatId,
              {
                text:
                  `✅ تسجلات المادة: ${subject}\n` +
                  'دابا كتب اسم الدرس أو السؤال.'
              }
            )

            continue
          }

          if (!user.subject) {
            await sock.sendMessage(
              chatId,
              {
                text:
                  'حدد المادة أولاً، مثلاً:\n' +
                  'مادة الرياضيات\n' +
                  'مادة اللغة العربية\n' +
                  'مادة الاجتماعيات'
              }
            )

            continue
          }

          const image =
            content?.imageMessage

          let imageBuffer = null
          let mimeType = 'image/jpeg'

          if (image) {
            await sock.sendMessage(
              chatId,
              {
                text:
                  '⏳ توصلت بالصورة، كنقراها ونشرحها ليك...'
              }
            )

            imageBuffer =
              await downloadMediaMessage(
                message,
                'buffer',
                {},
                {
                  logger,
                  reuploadRequest:
                    oldMessage =>
                      sock.updateMediaMessage(
                        oldMessage
                      )
                }
              )

            mimeType =
              image.mimetype ||
              mimeType
          }

          const answer =
            await askGemini(
              user,
              text ||
                'شرح وحل هذا التمرين المصور خطوة بخطوة بطريقة مناسبة للثالثة إعدادي.',
              imageBuffer,
              mimeType
            )

          await sock.sendMessage(
            chatId,
            {
              text: answer
            }
          )
        } catch (error) {
          console.log(
            'MESSAGE ERROR:',
            error.message
          )

          try {
            const quotaError =
              /429|quota|too many requests|limit: 0/i
                .test(error.message)

            await sock.sendMessage(
              message.key.remoteJid,
              {
                text: quotaError
                  ? 'الموديل المجاني سالات أو ما عندوش الحصة دابا. بدّل GEMINI_MODEL إلى gemini-3-flash-preview فـRailway، ومن بعد دير Redeploy.'
                  : `وقع مشكل: ${error.message}`
              }
            )
          } catch {}
        }
      }
    }
  )
}

start()
                                
