// What is wrong with a new password and its repeat, in words a client can use, or nothing when it will do.
export function passwordProblem(password, confirm) {
  if (typeof password !== 'string' || password.length < 8) return 'Please choose a password of at least 8 characters.'
  if (password !== confirm) return 'The two passwords are not the same. Please type them again.'
  return ''
}
