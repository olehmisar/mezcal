import { omit } from "lodash-es";
import * as FormShadcn from "../ui/form";
import Checkbox from "./Checkbox.svelte";
import CurrencyInput from "./CurrencyInput.svelte";
import FormComponent from "./Form.svelte";
import SubmitButton from "./SubmitButton.svelte";

export const Form = Object.assign(FormComponent, {
  SubmitButton,
  Checkbox,
  CurrencyInput,
  ...omit(FormShadcn, ["Form"]),
});
