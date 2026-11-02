// A password reset email sent before the reset page existed opens the booking page or Your bookings, with the link's secret after the #.
// Send it, unread, to the page that asks for the new password. The Admin has its own reset page and is left alone.
// It runs before the app, as a file rather than inline so the Content-Security-Policy can refuse inline scripts (ADR-087).
(function () {
  var path = location.pathname.replace(/\/$/, '')
  if (/(^|[#&])type=recovery(&|$)/.test(location.hash) && path !== '/reset-password' && path.indexOf('/admin') !== 0) location.replace('/reset-password' + location.hash)
})()
