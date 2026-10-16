// A small set of line icons, drawn once and used sparingly: navigation and the quick contact buttons.
// They are decoration only (aria-hidden); every control that uses one also has a text label.
const paths = {
  calendar: <><rect x="3.5" y="5" width="17" height="15" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17" /></>,
  check: <><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12.3 2.4 2.4 4.6-5" /></>,
  bell: <><path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>,
  users: <><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19c.5-3.2 2.8-5 5.5-5s5 1.8 5.5 5" /><circle cx="17" cy="9.5" r="2.4" /><path d="M16 14.2c2.4-.2 4 1.4 4.5 4.3" /></>,
  more: <><circle cx="5.5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="18.5" cy="12" r="1.4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  phone: <path d="M6.5 4h3l1.4 3.8-1.9 1.2a11 11 0 0 0 5 5l1.2-1.9 3.8 1.4v3A2.5 2.5 0 0 1 16.5 20 12.5 12.5 0 0 1 4 7.5 2.5 2.5 0 0 1 6.5 4z" />,
  chat: <path d="M4 20l1.2-4A8 8 0 1 1 8 18.8z" />,
  pin: <><path d="M12 21s6.5-5.4 6.5-11A6.5 6.5 0 0 0 5.5 10c0 5.6 6.5 11 6.5 11z" /><circle cx="12" cy="10" r="2.3" /></>,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="m4.5 7.5 7.5 5.5 7.5-5.5" /></>,
  left: <path d="m15 6-6 6 6 6" />,
  right: <path d="m9 6 6 6-6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  up: <path d="m6 15 6-6 6 6" />,
  refresh: <><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20 4v5h-5" /></>,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2.5" /><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" /></>,
  sparkle: <path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18l-1.8-5.4L4.5 10.8 10.2 9z" />,
  tick: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  minus: <path d="M5 12h14" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  download: <><path d="M12 4v10M7.5 10 12 14.5 16.5 10" /><path d="M5 19.5h14" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2.5" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
  gear: <><path d="M10.29 5.62L10.53 3.22L13.47 3.22L13.71 5.62L15.3 6.28L17.17 4.75L19.25 6.83L17.72 8.7L18.38 10.29L20.78 10.53L20.78 13.47L18.38 13.71L17.72 15.3L19.25 17.17L17.17 19.25L15.3 17.72L13.71 18.38L13.47 20.78L10.53 20.78L10.29 18.38L8.7 17.72L6.83 19.25L4.75 17.17L6.28 15.3L5.62 13.71L3.22 13.47L3.22 10.53L5.62 10.29L6.28 8.7L4.75 6.83L6.83 4.75L8.7 6.28Z" /><circle cx="12" cy="12" r="2.8" /></>,
  block: <><circle cx="12" cy="12" r="8.5" /><path d="m6 6 12 12" /></>,
  car: <><path d="M6.5 11l1.4-3.3a2 2 0 0 1 1.9-1.2h4.4a2 2 0 0 1 1.9 1.2L17.5 11" /><rect x="4" y="11" width="16" height="6" rx="2" /><circle cx="8" cy="17.4" r="1.4" /><circle cx="16" cy="17.4" r="1.4" /></>,
  cross: <><circle cx="12" cy="12" r="8.5" /><path d="m9 9 6 6M15 9l-6 6" /></>,
}

export default function Icon({ name, size = 24, filled = false, className = '' }) {
  return <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>
}
