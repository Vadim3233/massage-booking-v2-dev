export function paymentConfig(env) {
  const accountName = env.VITE_BANK_ACCOUNT_NAME?.trim() || ''
  const bankName = env.VITE_BANK_NAME?.trim() || 'WISE'
  const sortCode = env.VITE_BANK_SORT_CODE?.trim() || ''
  const accountNumber = env.VITE_BANK_ACCOUNT_NUMBER?.trim() || ''
  return { accountName, bankName, sortCode, accountNumber,
    configured: Boolean(accountName && /^\d{6}$/.test(sortCode.replaceAll('-', '')) && /^\d{8}$/.test(accountNumber)),
  }
}

// Bank details the Admin saved in the app. They take priority; the build-time values are the fallback.
export function bankFromSettings(row) {
  if (!row) return null
  const accountName = String(row.account_name || '').trim()
  const sortCode = String(row.sort_code || '').trim()
  const accountNumber = String(row.account_number || '').trim()
  return { accountName, bankName: String(row.bank_name || '').trim(), sortCode, accountNumber, note: String(row.note || '').trim(),
    configured: Boolean(accountName && /^\d{6}$/.test(sortCode.replaceAll('-', '')) && /^\d{8}$/.test(accountNumber)) }
}
export const chooseBank = (saved, fallback) => saved?.configured ? saved : fallback
