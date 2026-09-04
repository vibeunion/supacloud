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
});
