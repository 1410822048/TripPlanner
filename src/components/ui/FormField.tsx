// src/components/ui/FormField.tsx
// 表單欄位（label + child input + error message）
interface FormFieldProps {
  label: string
  error?: string
  required?: boolean
  children: React.ReactNode
  /** flex-basis（套在整個 field wrapper） */
  className?: string
}

export default function FormField({ label, error, required, children, className }: FormFieldProps) {
  return (
    <div className={`flex flex-col gap-1.5 min-w-0 ${className ?? ''}`}>
      <label
        className={[
          'text-[11px] font-semibold uppercase tracking-[0.08em]',
          error ? 'text-danger' : 'text-muted',
        ].join(' ')}
      >
        {label}
        {required && <span className="text-danger ml-[3px]">*</span>}
      </label>
      {children}
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </div>
  )
}
