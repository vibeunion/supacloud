import { describe, expect, test } from "bun:test";
import { FormArray, FormControl, FormGroup, Validators } from "./forms";

describe("Angular-style Reactive Forms & Validation (@angular/forms)", () => {
  test("FormControl basic state, value tracking, and required validator", () => {
    const name = new FormControl("", Validators.required);
    expect(name.value).toBe("");
    expect(name.valid).toBe(false);
    expect(name.invalid).toBe(true);
    expect(name.hasError("required")).toBe(true);
    expect(name.pristine).toBe(true);
    expect(name.touched).toBe(false);

    name.setValue("Alice");
    expect(name.value).toBe("Alice");
    expect(name.valid).toBe(true);
    expect(name.invalid).toBe(false);
    expect(name.dirty).toBe(true);

    name.markAsTouched();
    expect(name.touched).toBe(true);

    name.reset();
    expect(name.value).toBe(null as any);
    expect(name.pristine).toBe(true);
    expect(name.touched).toBe(false);
    expect(name.valid).toBe(false);
  });

  test("Validators collection (email, min, max, minLength, maxLength, pattern)", () => {
    const email = new FormControl("bad-email", Validators.email);
    expect(email.invalid).toBe(true);
    expect(email.hasError("email")).toBe(true);
    email.setValue("alice@example.com");
    expect(email.valid).toBe(true);

    const age = new FormControl(15, [Validators.required, Validators.min(18), Validators.max(65)]);
    expect(age.invalid).toBe(true);
    expect(age.hasError("min")).toBe(true);
    expect(age.getError("min")).toEqual({ min: 18, actual: 15 });
    age.setValue(25);
    expect(age.valid).toBe(true);
    age.setValue(70);
    expect(age.hasError("max")).toBe(true);

    const code = new FormControl("AB", [Validators.minLength(3), Validators.maxLength(5), Validators.pattern(/^[A-Z]+$/)]);
    expect(code.hasError("minlength")).toBe(true);
    code.setValue("ABCDE");
    expect(code.valid).toBe(true);
    code.setValue("ABCDEF");
    expect(code.hasError("maxlength")).toBe(true);
    code.setValue("123");
    expect(code.hasError("pattern")).toBe(true);

    const agree = new FormControl(false, Validators.requiredTrue);
    expect(agree.invalid).toBe(true);
    agree.setValue(true);
    expect(agree.valid).toBe(true);
  });

  test("FormGroup aggregates child control values and validity", () => {
    const profileForm = new FormGroup({
      username: new FormControl("", Validators.required),
      email: new FormControl("", [Validators.required, Validators.email]),
      details: new FormGroup({
        age: new FormControl(0, Validators.min(1)),
      }),
    });

    expect(profileForm.valid).toBe(false);
    expect(profileForm.value).toEqual({
      username: "",
      email: "",
      details: { age: 0 },
    });

    expect(profileForm.get("username")?.hasError("required")).toBe(true);
    expect(profileForm.get("details.age")?.hasError("min")).toBe(true);

    profileForm.patchValue({
      username: "bob",
      email: "bob@supacloud.dev",
      details: { age: 30 },
    });

    expect(profileForm.valid).toBe(true);
    expect(profileForm.value).toEqual({
      username: "bob",
      email: "bob@supacloud.dev",
      details: { age: 30 },
    });
    expect(profileForm.dirty).toBe(true);
  });

  test("FormArray manages dynamic lists of controls", () => {
    const tags = new FormArray([
      new FormControl("angular", Validators.required),
      new FormControl("compiler", Validators.required),
    ]);

    expect(tags.length).toBe(2);
    expect(tags.value).toEqual(["angular", "compiler"]);
    expect(tags.valid).toBe(true);

    tags.push(new FormControl("", Validators.required));
    expect(tags.length).toBe(3);
    expect(tags.valid).toBe(false);

    tags.removeAt(2);
    expect(tags.length).toBe(2);
    expect(tags.valid).toBe(true);
  });

  test("Async validators support", async () => {
    const checkUsername = async (ctrl: any) => {
      if (ctrl.value === "admin") {
        return { usernameTaken: true };
      }
      return null;
    };

    const username = new FormControl("user", null, checkUsername);
    // Wait for microtask resolution
    await new Promise((r) => setTimeout(r, 10));
    expect(username.valid).toBe(true);

    username.setValue("admin");
    await new Promise((r) => setTimeout(r, 10));
    expect(username.invalid).toBe(true);
    expect(username.hasError("usernameTaken")).toBe(true);
  });

  test("ignores stale async validator results", async () => {
    const resolvers = new Map<string, (errors: Record<string, unknown> | null) => void>();
    const username = new FormControl("first", null, (ctrl) => new Promise((resolve) => {
      resolvers.set(String(ctrl.value), resolve);
    }));

    username.setValue("second");
    resolvers.get("first")?.({ stale: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(username.pending).toBe(true);

    resolvers.get("second")?.(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(username.valid).toBe(true);
    expect(username.errors).toBeNull();
  });

  test("recalculates nested parents after async validation completes", async () => {
    let resolveChild!: (errors: Record<string, unknown> | null) => void;
    const child = new FormControl("value", null, () => new Promise((resolve) => {
      resolveChild = resolve;
    }));
    const group = new FormGroup({ child });
    const root = new FormGroup({ group });

    expect(group.pending).toBe(true);
    expect(root.pending).toBe(true);
    resolveChild(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(child.valid).toBe(true);
    expect(group.valid).toBe(true);
    expect(root.valid).toBe(true);
  });

  test("converts rejected async validators into a stable validation error", async () => {
    const control = new FormControl("value", null, async () => {
      throw new Error("network unavailable");
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(control.pending).toBe(false);
    expect(control.invalid).toBe(true);
    expect(control.hasError("asyncValidator")).toBe(true);
  });

  test("keeps disabled groups and arrays disabled during parent aggregation", () => {
    const group = new FormGroup({
      child: new FormControl("value", Validators.required),
    });
    const array = new FormArray([
      new FormControl("value", Validators.required),
    ]);

    group.disable();
    array.disable();
    group.updateValueAndValidity();
    array.updateValueAndValidity();

    expect(group.disabled).toBe(true);
    expect(group.valid).toBe(false);
    expect(group.errors).toBeNull();
    expect(array.disabled).toBe(true);
    expect(array.valid).toBe(false);
    expect(array.errors).toBeNull();
  });

  test("clears stale child aggregation errors while a child is pending", () => {
    let resolveChild!: (errors: Record<string, unknown> | null) => void;
    const child = new FormControl("", Validators.required);
    const group = new FormGroup({ child });

    expect(group.invalid).toBe(true);
    const asyncChild = new FormControl("value", null, () => new Promise((resolve) => {
      resolveChild = resolve;
    }));
    group.setControl("child", asyncChild);

    expect(group.pending).toBe(true);
    expect(group.errors).toBeNull();
    resolveChild(null);
  });

  test("ignores container async results after a child becomes invalid", async () => {
    for (const array of [false, true]) {
      const child = new FormControl("value", Validators.required);
      let finish!: (errors: null) => void;
      const validate = () => new Promise<null>((resolve) => { finish = resolve; });
      const container = array
        ? new FormArray([child], null, validate)
        : new FormGroup({ child }, null, validate);
      const root = new FormGroup({ container });

      expect(container.pending).toBe(true);
      child.setValue("");
      expect(container.invalid).toBe(true);
      finish(null);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(container.invalid).toBe(true);
      expect(root.invalid).toBe(true);
      expect(container.hasError("invalidChildren")).toBe(true);
    }
  });
});
