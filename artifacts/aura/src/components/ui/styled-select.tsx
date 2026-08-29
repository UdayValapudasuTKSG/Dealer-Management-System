"use client";

import * as React from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type StyledSelectOption = {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
};

type StyledSelectProps = Omit<
  React.ComponentPropsWithoutRef<typeof SelectTrigger>,
  "children" | "defaultValue" | "disabled" | "onChange" | "value"
> & {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly StyledSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  name?: string;
  required?: boolean;
};

const EMPTY_SENTINEL_BASE = "__aura_styled_select_empty__";

export function StyledSelect({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  name,
  required,
  className,
  ...triggerProps
}: StyledSelectProps) {
  const emptySentinel = React.useMemo(() => {
    let sentinel = EMPTY_SENTINEL_BASE;
    const values = new Set(options.map((option) => option.value));
    while (values.has(sentinel)) sentinel += "_";
    return sentinel;
  }, [options]);

  const toRadixValue = (optionValue: string) =>
    optionValue === "" ? emptySentinel : optionValue;
  const hasEmptyOption = options.some((option) => option.value === "");
  const radixValue =
    value === "" && !hasEmptyOption ? undefined : toRadixValue(value);

  return (
    <Select
      value={radixValue}
      onValueChange={(nextValue) =>
        onValueChange(nextValue === emptySentinel ? "" : nextValue)
      }
      disabled={disabled}
      name={name}
      required={required}
    >
      <SelectTrigger className={className} {...triggerProps}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option, index) => (
          <SelectItem
            key={`${option.value}-${index}`}
            value={toRadixValue(option.value)}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}