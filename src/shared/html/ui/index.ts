// Barrel for the vendored design system (basecn: shadcn/ui on Base UI).
// Components render to static HTML via react-dom/server; anything that
// needs client JavaScript to function was adapted to a native element
// (see the per-file headers for what changed and why).

export { Alert, AlertDescription, AlertTitle } from './alert.js';
export { Badge, badgeVariants } from './badge.js';
export { Button, buttonVariants } from './button.js';
export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './card.js';
export { Checkbox } from './checkbox.js';
export { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible.js';
export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from './field.js';
export { Input } from './input.js';
export { Kbd, KbdGroup } from './kbd.js';
export { Label } from './label.js';
export { RadioGroup, RadioGroupItem } from './radio-group.js';
export { Separator } from './separator.js';
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from './table.js';
export { Textarea } from './textarea.js';
export { cn } from './utils.js';
