// Normalized style properties shared by the design extractor and the browser inspector.
// Numbers are CSS pixels; colors are lowercase #rrggbb or #rrggbbaa.
export interface StyleProps {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  gap?: number; // main-axis spacing of a flex/auto-layout container
  rowGap?: number;
  columnGap?: number;
  borderRadius?: number;
  borderWidth?: number;
  borderColor?: string;
  color?: string;
  backgroundColor?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: string;
  opacity?: number;
}

export type PropName = keyof StyleProps;

export interface ComponentSpec {
  name: string;
  props: StyleProps;
  children?: string[];
}

export interface InspectedComponent {
  name: string;
  selector: string;
  found: boolean;
  props: StyleProps;
}

export type Status = 'PASS' | 'FAIL' | 'WARNING';
export type Severity = 'low' | 'medium' | 'high';
export type Mode = 'quick' | 'deep';

export interface Finding {
  component: string;
  property: string;
  expected: string | number | null;
  actual: string | number | null;
  status: Exclude<Status, 'PASS'>;
  severity: Severity;
  viewport?: string;
}

export interface Viewport {
  name: string;
  width: number;
  height: number;
}

export interface Tolerances {
  size: number;
  position: number;
  spacing: number;
  radius: number;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  fontWeight: number;
  color: number;
  opacity: number;
}

export interface ComponentConfig {
  name: string;
  selector: string;
  path?: string;
  figmaNodeId?: string;
  expected?: StyleProps;
  reference?: string;
  ignore?: PropName[];
  tolerances?: Partial<Tolerances>;
  screenshot?: Partial<ValidationConfig['screenshot']>;
  // Per-viewport overrides for responsive designs, keyed by viewport name.
  responsive?: Record<string, { figmaNodeId?: string; expected?: StyleProps; reference?: string }>;
}

export interface ValidationConfig {
  baseUrl: string;
  viewports: Viewport[];
  // frameNodeId: page frame used as origin for x/y alignment checks.
  figma?: { fileKey: string; frameNodeId?: string; cacheTtlHours?: number };
  designSpecPath?: string;
  tolerances: Tolerances;
  screenshot: { threshold: number; maxDiffRatio: number };
  // Only these properties are compared in quick mode; deep mode compares every property present in the design.
  quickProperties: PropName[];
  cacheDir: string;
  outputDir: string;
  components: ComponentConfig[];
}

export interface Summary {
  status: Status;
  checked: number;
  failed: number;
  warnings: number;
}
