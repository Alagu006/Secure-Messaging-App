/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        whatsapp: {
          teal: "#075E54",
          "teal-dark": "#054D44",
          green: "#25D366",
          "green-dark": "#20BD5A",
          "light-green": "#DCF8C6",
          "chat-bg": "#E5DDD5",
          sidebar: "#F0F2F5",
          "sidebar-header": "#F0F2F5",
          "bubble-sent": "#D9FDD3",
          "bubble-received": "#FFFFFF",
          "input-bar": "#F0F2F5",
          "tick-gray": "#8696A0",
          "tick-blue": "#53BDEB",
        },
      },
    },
  },
  plugins: [],
}
