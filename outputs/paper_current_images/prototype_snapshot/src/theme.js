import { createTheme } from '@mui/material/styles'

const theme = createTheme({
  palette: {
    primary: {
      main: '#9f1d2d',
      dark: '#7f1421',
      contrastText: '#ffffff',
    },
    secondary: {
      main: '#102f46',
      contrastText: '#ffffff',
    },
    background: {
      default: '#f5f7f8',
      paper: '#ffffff',
    },
  },
  typography: {
    fontFamily: 'Montserrat, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiButton: {
      defaultProps: {
        disableElevation: true,
      },
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 800,
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 700,
        },
      },
    },
  },
})

export default theme
