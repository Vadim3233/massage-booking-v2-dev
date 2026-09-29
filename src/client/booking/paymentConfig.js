export function paymentConfig(env) {
  const accountName = env.VITE_BANK_ACCOUNT_NAME?.trim() || ''
  const bankName = env.VITE_BANK_NAME?.trim() || 'WISE'
  const sortCode = env.VITE_BANK_SORT_CODE?.trim() || ''
  const accountNumber = env.VITE_BANK_ACCOUNT_NUMBER?.trim() || ''
  return { accountName, bankName, sortCode, accountNumber,
    configured: Boolean(accountName && /^\d{6}$/.test(sortCode.replaceAll('-', '')) && /^\d{8}$/.test(accountNumber)),
  }
}
