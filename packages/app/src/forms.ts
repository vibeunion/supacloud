/**
 * Angular-style Reactive Forms & Validation Suite (@angular/forms).
 * Zero-dependency, type-safe, reactive form model and validator collection.
 */

export type FormControlStatus = "VALID" | "INVALID" | "PENDING" | "DISABLED";

export type ValidationErrors = Record<string, unknown>;

export type ValidatorFn = (control: AbstractControl) => ValidationErrors | null;

export type AsyncValidatorFn = (
  control: AbstractControl,
) => Promise<ValidationErrors | null>;

export interface AbstractControlOptions {
  validators?: ValidatorFn | ValidatorFn[] | null;
  asyncValidators?: AsyncValidatorFn | AsyncValidatorFn[] | null;
}

/**
 * Base class for all Angular-style form controls: FormControl, FormGroup, FormArray.
 */
export abstract class AbstractControl<TValue = any> {
  private _value!: TValue;
  private _status: FormControlStatus = "VALID";
  private _errors: ValidationErrors | null = null;
  private _pristine = true;
  private _touched = false;
  private _parent: FormGroup | FormArray | null = null;
  protected _validator: ValidatorFn | null = null;
  protected _asyncValidator: AsyncValidatorFn | null = null;

  constructor(
    validatorOrOpts?: ValidatorFn | ValidatorFn[] | AbstractControlOptions | null,
    asyncValidator?: AsyncValidatorFn | AsyncValidatorFn[] | null,
  ) {
    if (
      validatorOrOpts &&
      typeof validatorOrOpts === "object" &&
      !Array.isArray(validatorOrOpts) &&
      ("validators" in validatorOrOpts || "asyncValidators" in validatorOrOpts)
    ) {
      const opts = validatorOrOpts as AbstractControlOptions;
      this._validator = Validators.compose(
        opts.validators
          ? Array.isArray(opts.validators)
            ? opts.validators
            : [opts.validators]
          : null,
      );
      this._asyncValidator = Validators.composeAsync(
        opts.asyncValidators
          ? Array.isArray(opts.asyncValidators)
            ? opts.asyncValidators
            : [opts.asyncValidators]
          : null,
      );
    } else {
      const v = validatorOrOpts as ValidatorFn | ValidatorFn[] | null | undefined;
      this._validator = Validators.compose(
        v
          ? Array.isArray(v)
            ? v
            : [v]
          : null,
      );
      this._asyncValidator = Validators.composeAsync(
        asyncValidator
          ? Array.isArray(asyncValidator)
            ? asyncValidator
            : [asyncValidator]
          : null,
      );
    }
  }

  get value(): TValue {
    return this._value;
  }

  protected setRawValue(val: TValue): void {
    this._value = val;
  }

  get status(): FormControlStatus {
    return this._status;
  }

  get valid(): boolean {
    return this._status === "VALID";
  }

  get invalid(): boolean {
    return this._status === "INVALID";
  }

  get pending(): boolean {
    return this._status === "PENDING";
  }

  get disabled(): boolean {
    return this._status === "DISABLED";
  }

  get enabled(): boolean {
    return this._status !== "DISABLED";
  }

  get errors(): ValidationErrors | null {
    return this._errors;
  }

  get pristine(): boolean {
    return this._pristine;
  }

  get dirty(): boolean {
    return !this._pristine;
  }

  get touched(): boolean {
    return this._touched;
  }

  get untouched(): boolean {
    return !this._touched;
  }

  get parent(): FormGroup | FormArray | null {
    return this._parent;
  }

  setParent(parent: FormGroup | FormArray | null): void {
    this._parent = parent;
  }

  markAsTouched(): void {
    this._touched = true;
  }

  markAsUntouched(): void {
    this._touched = false;
  }

  markAsDirty(): void {
    this._pristine = false;
    if (this._parent) this._parent.markAsDirty();
  }

  markAsPristine(): void {
    this._pristine = true;
  }

  disable(): void {
    this._status = "DISABLED";
    this._errors = null;
    if (this._parent) this._parent.updateValueAndValidity();
  }

  enable(): void {
    this._status = "VALID";
    this.updateValueAndValidity();
  }

  setErrors(errors: ValidationErrors | null): void {
    this._errors = errors;
    this._status = errors ? "INVALID" : "VALID";
  }

  hasError(errorCode: string, path?: string | (string | number)[]): boolean {
    return this.getError(errorCode, path) !== null;
  }

  getError(errorCode: string, path?: string | (string | number)[]): unknown {
    const control = path ? this.get(path) : this;
    if (!control || !control._errors) return null;
    return control._errors[errorCode] ?? null;
  }

  abstract setValue(value: any): void;
  abstract patchValue(value: any): void;
  abstract reset(value?: any): void;

  get(_path: string | (string | number)[]): AbstractControl | null {
    return null;
  }

  updateValueAndValidity(): void {
    if (this.disabled) {
      this._status = "DISABLED";
      this._errors = null;
      return;
    }

    if (this._validator) {
      this._errors = this._validator(this);
    } else {
      this._errors = null;
    }

    this._status = this._errors ? "INVALID" : "VALID";

    if (this._status === "VALID" && this._asyncValidator) {
      this._status = "PENDING";
      this._asyncValidator(this).then((errors) => {
        if (this._status === "PENDING") {
          this.setErrors(errors);
        }
      });
    }

    if (this._parent) {
      this._parent.updateValueAndValidity();
    }
  }
}

/**
 * Tracks the value and validity status of an individual form control.
 */
export class FormControl<T = any> extends AbstractControl<T> {
  constructor(
    formState?: T | { value: T; disabled?: boolean },
    validatorOrOpts?: ValidatorFn | ValidatorFn[] | AbstractControlOptions | null,
    asyncValidator?: AsyncValidatorFn | AsyncValidatorFn[] | null,
  ) {
    super(validatorOrOpts, asyncValidator);
    if (
      formState &&
      typeof formState === "object" &&
      "value" in formState &&
      "disabled" in formState
    ) {
      this.setRawValue((formState as { value: T; disabled?: boolean }).value);
      if ((formState as { value: T; disabled?: boolean }).disabled) {
        this.disable();
      } else {
        this.updateValueAndValidity();
      }
    } else {
      this.setRawValue(formState as T);
      this.updateValueAndValidity();
    }
  }

  setValue(value: any): void {
    this.setRawValue(value as T);
    this.markAsDirty();
    this.updateValueAndValidity();
  }

  patchValue(value: any): void {
    this.setValue(value);
  }

  reset(formState?: any): void {
    this.setRawValue((formState !== undefined ? formState : null) as T);
    this.markAsPristine();
    this.markAsUntouched();
    this.updateValueAndValidity();
  }
}

/**
 * Tracks the value and validity status of a group of named AbstractControl instances.
 */
export class FormGroup<
  TControls extends Record<string, AbstractControl> = Record<string, AbstractControl>,
> extends AbstractControl<{ [K in keyof TControls]: TControls[K]["value"] }> {
  constructor(
    public readonly controls: TControls,
    validatorOrOpts?: ValidatorFn | ValidatorFn[] | AbstractControlOptions | null,
    asyncValidator?: AsyncValidatorFn | AsyncValidatorFn[] | null,
  ) {
    super(validatorOrOpts, asyncValidator);
    for (const ctrl of Object.values(controls)) {
      ctrl.setParent(this);
    }
    this.updateValueAndValidity();
  }

  override get value(): { [K in keyof TControls]: TControls[K]["value"] } {
    const res: Record<string, unknown> = {};
    for (const [key, ctrl] of Object.entries(this.controls)) {
      res[key] = ctrl.value;
    }
    return res as { [K in keyof TControls]: TControls[K]["value"] };
  }

  override get(path: string | (string | number)[]): AbstractControl | null {
    const parts = Array.isArray(path) ? path : path.split(".");
    let current: AbstractControl | null = this;
    for (const part of parts) {
      if (!current) return null;
      if (current instanceof FormGroup) {
        current = current.controls[String(part)] ?? null;
      } else if (current instanceof FormArray) {
        current = current.at(Number(part)) ?? null;
      } else {
        return null;
      }
    }
    return current;
  }

  addControl(name: string, control: AbstractControl): void {
    (this.controls as Record<string, AbstractControl>)[name] = control;
    control.setParent(this);
    this.updateValueAndValidity();
  }

  removeControl(name: string): void {
    const ctrl = (this.controls as Record<string, AbstractControl>)[name];
    if (ctrl) {
      ctrl.setParent(null);
      delete (this.controls as Record<string, AbstractControl>)[name];
      this.updateValueAndValidity();
    }
  }

  setControl(name: string, control: AbstractControl): void {
    this.removeControl(name);
    this.addControl(name, control);
  }

  contains(name: string): boolean {
    return Boolean((this.controls as Record<string, AbstractControl>)[name]);
  }

  setValue(value: any): void {
    for (const [key, val] of Object.entries(value)) {
      if (this.controls[key]) {
        this.controls[key].setValue(val);
      }
    }
    this.markAsDirty();
  }

  patchValue(value: any): void {
    for (const [key, val] of Object.entries(value)) {
      if (this.controls[key] && val !== undefined) {
        this.controls[key].patchValue(val);
      }
    }
    this.markAsDirty();
  }

  reset(): void {
    for (const ctrl of Object.values(this.controls)) {
      ctrl.reset();
    }
    this.markAsPristine();
    this.markAsUntouched();
  }

  override updateValueAndValidity(): void {
    if (this.disabled) {
      this.setErrors(null);
      return;
    }
    let hasInvalid = false;
    let hasPending = false;
    for (const ctrl of Object.values(this.controls)) {
      if (ctrl.invalid) hasInvalid = true;
      if (ctrl.pending) hasPending = true;
    }

    if (hasInvalid) {
      this.setErrors({ invalidChildren: true });
    } else if (hasPending) {
      (this as any)._status = "PENDING";
    } else {
      super.updateValueAndValidity();
    }
  }
}

/**
 * Tracks the value and validity status of an array of AbstractControl instances.
 */
export class FormArray<
  TControl extends AbstractControl = AbstractControl,
> extends AbstractControl<Array<TControl["value"]>> {
  constructor(
    public readonly controls: TControl[] = [],
    validatorOrOpts?: ValidatorFn | ValidatorFn[] | AbstractControlOptions | null,
    asyncValidator?: AsyncValidatorFn | AsyncValidatorFn[] | null,
  ) {
    super(validatorOrOpts, asyncValidator);
    for (const ctrl of controls) {
      ctrl.setParent(this);
    }
    this.updateValueAndValidity();
  }

  get length(): number {
    return this.controls.length;
  }

  at(index: number): TControl | null {
    return this.controls[index] ?? null;
  }

  push(control: TControl): void {
    this.controls.push(control);
    control.setParent(this);
    this.updateValueAndValidity();
  }

  insert(index: number, control: TControl): void {
    this.controls.splice(index, 0, control);
    control.setParent(this);
    this.updateValueAndValidity();
  }

  removeAt(index: number): void {
    if (index >= 0 && index < this.controls.length) {
      this.controls[index].setParent(null);
      this.controls.splice(index, 1);
      this.updateValueAndValidity();
    }
  }

  clear(): void {
    for (const ctrl of this.controls) {
      ctrl.setParent(null);
    }
    this.controls.length = 0;
    this.updateValueAndValidity();
  }

  override get value(): Array<TControl["value"]> {
    return this.controls.map((c) => c.value);
  }

  setValue(value: any): void {
    (value as any[]).forEach((val, i) => {
      if (this.controls[i]) this.controls[i].setValue(val);
    });
    this.markAsDirty();
  }

  patchValue(value: any): void {
    (value as any[]).forEach((val, i) => {
      if (this.controls[i] && val !== undefined) this.controls[i].patchValue(val);
    });
    this.markAsDirty();
  }

  reset(): void {
    for (const ctrl of this.controls) ctrl.reset();
    this.markAsPristine();
    this.markAsUntouched();
  }

  override updateValueAndValidity(): void {
    if (this.disabled) {
      this.setErrors(null);
      return;
    }
    let hasInvalid = false;
    let hasPending = false;
    for (const ctrl of this.controls) {
      if (ctrl.invalid) hasInvalid = true;
      if (ctrl.pending) hasPending = true;
    }

    if (hasInvalid) {
      this.setErrors({ invalidChildren: true });
    } else if (hasPending) {
      (this as any)._status = "PENDING";
    } else {
      super.updateValueAndValidity();
    }
  }
}

/**
 * Standard Angular-inspired Validators collection (@angular/forms).
 */
export class Validators {
  static nullValidator(_control: AbstractControl): null {
    return null;
  }

  static required(control: AbstractControl): ValidationErrors | null {
    const val = control.value;
    if (
      val === null ||
      val === undefined ||
      val === "" ||
      (Array.isArray(val) && val.length === 0)
    ) {
      return { required: true };
    }
    return null;
  }

  static requiredTrue(control: AbstractControl): ValidationErrors | null {
    return control.value === true ? null : { required: true };
  }

  static min(min: number): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const val = control.value;
      if (val === null || val === undefined || val === "") return null;
      const num = Number(val);
      return !Number.isNaN(num) && num < min ? { min: { min, actual: val } } : null;
    };
  }

  static max(max: number): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const val = control.value;
      if (val === null || val === undefined || val === "") return null;
      const num = Number(val);
      return !Number.isNaN(num) && num > max ? { max: { max, actual: val } } : null;
    };
  }

  static minLength(minLength: number): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const val = control.value;
      if (val === null || val === undefined) return null;
      const length = typeof val === "string" || Array.isArray(val) ? val.length : 0;
      return length < minLength
        ? { minlength: { requiredLength: minLength, actualLength: length } }
        : null;
    };
  }

  static maxLength(maxLength: number): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const val = control.value;
      if (val === null || val === undefined) return null;
      const length = typeof val === "string" || Array.isArray(val) ? val.length : 0;
      return length > maxLength
        ? { maxlength: { requiredLength: maxLength, actualLength: length } }
        : null;
    };
  }

  static email(control: AbstractControl): ValidationErrors | null {
    const val = control.value;
    if (!val) return null;
    const emailRegex =
      /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return typeof val === "string" && emailRegex.test(val) ? null : { email: true };
  }

  static pattern(pattern: string | RegExp): ValidatorFn {
    const regex = typeof pattern === "string" ? new RegExp(`^${pattern}$`) : pattern;
    return (control: AbstractControl): ValidationErrors | null => {
      const val = control.value;
      if (!val) return null;
      return regex.test(String(val))
        ? null
        : { pattern: { requiredPattern: String(pattern), actualValue: val } };
    };
  }

  static compose(
    validators: (ValidatorFn | null | undefined)[] | null,
  ): ValidatorFn | null {
    if (!validators) return null;
    const present = validators.filter(
      (v): v is ValidatorFn => typeof v === "function",
    );
    if (present.length === 0) return null;
    return (control: AbstractControl): ValidationErrors | null => {
      const errors: ValidationErrors = {};
      let hasErrors = false;
      for (const fn of present) {
        const err = fn(control);
        if (err) {
          Object.assign(errors, err);
          hasErrors = true;
        }
      }
      return hasErrors ? errors : null;
    };
  }

  static composeAsync(
    validators: (AsyncValidatorFn | null | undefined)[] | null,
  ): AsyncValidatorFn | null {
    if (!validators) return null;
    const present = validators.filter(
      (v): v is AsyncValidatorFn => typeof v === "function",
    );
    if (present.length === 0) return null;
    return async (control: AbstractControl): Promise<ValidationErrors | null> => {
      const results = await Promise.all(present.map((fn) => fn(control)));
      const errors: ValidationErrors = {};
      let hasErrors = false;
      for (const err of results) {
        if (err) {
          Object.assign(errors, err);
          hasErrors = true;
        }
      }
      return hasErrors ? errors : null;
    };
  }
}
