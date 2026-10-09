import { useState } from 'react'
import { IconButton, InputAdornment, TextField } from '@mui/material'

function VisibilityIcon({ visible }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
      {!visible && <path d="m3 3 18 18" />}
    </svg>
  )
}

export function PasswordField({ id, name, label, value, onChange, autoComplete, inputProps, helperText, required = true, fullWidth = true, sx }) {
  const [visible, setVisible] = useState(false)

  return (
    <TextField
      id={id}
      name={name}
      label={label}
      type={visible ? 'text' : 'password'}
      value={value}
      onChange={onChange}
      autoComplete={autoComplete}
      helperText={helperText}
      required={required}
      fullWidth={fullWidth}
      sx={sx}
      slotProps={{
        htmlInput: inputProps,
        input: {
          endAdornment: (
            <InputAdornment position="end">
              <IconButton
                type="button"
                aria-label={visible ? 'Hide password' : 'Show password'}
                aria-pressed={visible}
                onClick={() => setVisible((current) => !current)}
                edge="end"
                size="small"
              >
                <VisibilityIcon visible={visible} />
              </IconButton>
            </InputAdornment>
          ),
        },
      }}
    />
  )
}
