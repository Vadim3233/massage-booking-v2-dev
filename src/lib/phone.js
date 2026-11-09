// Does a typed phone number look like a real one? Used on the client's booking details and in the Admin's client forms, so a digit too
// many or too few is caught while the person is still typing, not when Vadim tries to ring. The database still accepts 7 to 20 digits,
// so numbers saved before this check keep working and can be corrected later.
//
// UK numbers (07…, 020…, +44…, 0044…): after the leading 0 a mobile has exactly 10 digits (07700 900123), and other numbers 9 or 10
// (a few old area codes and 0800 numbers have 9). Another country's number starts with + or 00 and has 8 to 15 digits in all.
// A UK mobile typed without its first 0 (7700 900123) is accepted. Spaces, dashes, dots, brackets and an extension at the end are fine.

const EXTENSION = /\s*(?:ext\.?|extension|x)\s*\d{1,6}\s*$/i
const GUIDE = 'A UK mobile number has 11 digits and starts with 07.'

function ukProblem(national) {
  const most = 10
  const least = national.startsWith('7') ? 10 : 9
  if (national.length > most) {
    const extra = national.length - most
    return `That number has ${extra === 1 ? 'one digit' : `${extra} digits`} too many for a UK number. ${GUIDE}`
  }
  if (national.length < least) return `That number is too short for a UK number. ${GUIDE}`
  return ''
}

// '' when the number looks right (or nothing is typed); otherwise one plain sentence saying what is wrong.
export function phoneProblem(text) {
  const typed = String(text || '').trim()
  if (!typed) return ''
  const main = typed.replace(EXTENSION, '')
  const digits = main.replace(/\D/g, '')
  if (/[^0-9+()\-.\s]/.test(main) || /.\+/.test(main) || !digits) return "That number doesn't look right. Use only digits, spaces and a + at the start."
  const international = main.startsWith('+') ? digits : digits.startsWith('00') ? digits.slice(2) : null
  if (international !== null) {
    // +44 (0)20… is a common way to write a UK number: the (0) is dropped.
    if (international.startsWith('44')) return ukProblem(international.slice(2).replace(/^0/, ''))
    return international.length >= 8 && international.length <= 15 ? '' : "That number doesn't look right. Please check the country code and the number."
  }
  if (digits.startsWith('0')) return ukProblem(digits.slice(1))
  if (digits.startsWith('44') && digits.length >= 11 && digits.length <= 13) return ukProblem(digits.slice(2).replace(/^0/, ''))
  if (digits.startsWith('7')) return ukProblem(digits)
  return "That number doesn't look right. Start a UK number with 0 or +44, or another country's number with + and its code."
}
