// Exportación a CSV compatible con Excel en español (separador ";" y BOM UTF-8).

export interface CsvColumn<T> {
  header: string
  value: (row: T) => string | number | null | undefined
}

function escape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((c) => escape(c.header)).join(';')]
  for (const row of rows) lines.push(columns.map((c) => escape(c.value(row))).join(';'))
  return lines.join('\r\n')
}

export function downloadCsv<T>(filename: string, rows: T[], columns: CsvColumn<T>[]) {
  const blob = new Blob(['﻿', toCsv(rows, columns)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Monto en unidades mínimas -> número decimal con coma, para Excel en español. */
export function csvAmount(minor: number, decimals: number): string {
  return (minor / 10 ** decimals).toFixed(decimals).replace('.', ',')
}
