export const BRAND = {
  appName: "MF MEDICAL EQUIPMENT SEVA(MES)",
  fullName: "Mahesh Foundation medical equipment seva",
  foundationName: "Mahesh Foundation",
  logoSrc: "/mf-mes-logo.jpeg",
  emergencyContacts: ["SANJAY LAHOTI", "Dr RADHEY SHYAM TAPADIA"],
  contactEmail: "",
} as const;

export function emergencyContactText() {
  return BRAND.emergencyContacts.join(" / ");
}
