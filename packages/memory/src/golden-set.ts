/**
 * A small golden set for retrieval quality, mixed Persian and English: one invented
 * business (a dental clinic), twelve passages, two questions per passage. Half of the
 * questions are in the same language as their passage and half are in the other one,
 * because the first customers' documents and questions will not always match.
 *
 * Invented content only: no customer data belongs here (docs/adr/memory-and-retrieval.md).
 * Twenty-four questions can only reveal a gross failure; they cannot certify quality.
 */
export interface GoldenPassage {
  readonly id: string;
  readonly language: "fa" | "en";
  readonly text: string;
}

export interface GoldenQuestion {
  readonly question: string;
  readonly language: "fa" | "en";
  /** The id of the single passage that answers it. */
  readonly expected: string;
  /** "cross" when the question and the passage are in different languages. */
  readonly kind: "same" | "cross";
}

export const GOLDEN_PASSAGES: readonly GoldenPassage[] = [
  {
    id: "hours",
    language: "en",
    text: "Maple Dental Clinic is open Monday to Friday from 8:00 to 17:00 and on Saturdays from 9:00 to 13:00. We are closed on Sundays and on public holidays.",
  },
  {
    id: "cleaning-price",
    language: "fa",
    text: "جرم‌گیری و پولیش دندان ۱۲۰ دلار است. اگر بیمه دارید، بیمه معمولاً ۸۰ درصد آن را پوشش می‌دهد.",
  },
  {
    id: "emergency",
    language: "en",
    text: "For a dental emergency such as a knocked-out tooth or severe pain, call 416-555-0142 at any time. After hours the call is forwarded to the on-call dentist and you will be seen within two hours.",
  },
  {
    id: "cancellation",
    language: "fa",
    text: "برای لغو یا تغییر وقت باید حداقل ۲۴ ساعت قبل خبر بدهید. در غیر این صورت ۵۰ دلار هزینهٔ عدم حضور دریافت می‌شود.",
  },
  {
    id: "location",
    language: "en",
    text: "We are at 220 Maple Street, second floor, next to the Don Mills subway station. Free parking is available behind the building for patients.",
  },
  {
    id: "languages",
    language: "fa",
    text: "دکتر سارا احمدی و دکتر پیمان رضایی به فارسی، انگلیسی و ترکی صحبت می‌کنند. دکتر لی به انگلیسی و چینی صحبت می‌کند.",
  },
  {
    id: "whitening",
    language: "en",
    text: "Professional teeth whitening takes about one hour and costs 350 dollars. Results usually last one to two years. It is not recommended for pregnant women.",
  },
  {
    id: "children",
    language: "fa",
    text: "دندان‌پزشکی کودکان برای بچه‌های زیر ۱۲ سال انجام می‌شود. اولین معاینهٔ کودک رایگان است و والدین می‌توانند کنار فرزند بمانند.",
  },
  {
    id: "payment",
    language: "en",
    text: "We accept Visa, Mastercard, debit and e-transfer. Cash is not accepted. Payment plans over six months are available for treatments above 1,000 dollars.",
  },
  {
    id: "first-visit",
    language: "fa",
    text: "در اولین ویزیت لطفاً کارت بیمه، کارت شناسایی و فهرست داروهای مصرفی خود را بیاورید. فرم اطلاعات پزشکی ۱۵ دقیقه قبل از وقت پر می‌شود.",
  },
  {
    id: "root-canal",
    language: "en",
    text: "A root canal on a front tooth costs 900 dollars and on a molar 1,300 dollars. Treatment usually takes two visits.",
  },
  {
    id: "aligners",
    language: "fa",
    text: "درمان ارتودنسی نامرئی (اینویزالاین) حدود ۶ هزار تا ۸ هزار دلار هزینه دارد و ۱۲ تا ۱۸ ماه طول می‌کشد. مشاورهٔ اولیه رایگان است.",
  },
];

export const GOLDEN_QUESTIONS: readonly GoldenQuestion[] = [
  { question: "What time do you close on Saturdays?", language: "en", expected: "hours", kind: "same" },
  { question: "شنبه‌ها تا چه ساعتی باز هستید؟", language: "fa", expected: "hours", kind: "cross" },
  { question: "جرم‌گیری چقدر هزینه دارد؟", language: "fa", expected: "cleaning-price", kind: "same" },
  { question: "How much is a teeth cleaning, and does insurance cover it?", language: "en", expected: "cleaning-price", kind: "cross" },
  { question: "My tooth got knocked out at night, who do I call?", language: "en", expected: "emergency", kind: "same" },
  { question: "شب دندانم بر اثر ضربه افتاده، با کجا تماس بگیرم؟", language: "fa", expected: "emergency", kind: "cross" },
  { question: "اگر نتوانم سر وقت بیایم چه می‌شود؟ هزینه دارد؟", language: "fa", expected: "cancellation", kind: "same" },
  { question: "What is the fee if I miss my appointment?", language: "en", expected: "cancellation", kind: "cross" },
  { question: "Where are you located and is there parking?", language: "en", expected: "location", kind: "same" },
  { question: "آدرس کلینیک کجاست و پارکینگ دارد؟", language: "fa", expected: "location", kind: "cross" },
  { question: "آیا دکتری هست که فارسی صحبت کند؟", language: "fa", expected: "languages", kind: "same" },
  { question: "Do any of your dentists speak Persian?", language: "en", expected: "languages", kind: "cross" },
  { question: "How long does whitening last?", language: "en", expected: "whitening", kind: "same" },
  { question: "سفید کردن دندان چقدر طول می‌کشد و چند است؟", language: "fa", expected: "whitening", kind: "cross" },
  { question: "آیا کودک ۸ ساله را هم می‌پذیرید؟", language: "fa", expected: "children", kind: "same" },
  { question: "Do you see children and is the first visit free?", language: "en", expected: "children", kind: "cross" },
  { question: "Can I pay in cash or by installments?", language: "en", expected: "payment", kind: "same" },
  { question: "می‌توانم اقساطی پرداخت کنم؟", language: "fa", expected: "payment", kind: "cross" },
  { question: "در اولین ویزیت چه چیزهایی باید با خودم ببرم؟", language: "fa", expected: "first-visit", kind: "same" },
  { question: "What should I bring to my first appointment?", language: "en", expected: "first-visit", kind: "cross" },
  { question: "What does a root canal on a molar cost?", language: "en", expected: "root-canal", kind: "same" },
  { question: "عصب‌کشی دندان آسیاب چند است؟", language: "fa", expected: "root-canal", kind: "cross" },
  { question: "اینویزالاین چقدر طول می‌کشد؟", language: "fa", expected: "aligners", kind: "same" },
  { question: "How much do clear aligners cost?", language: "en", expected: "aligners", kind: "cross" },
];
