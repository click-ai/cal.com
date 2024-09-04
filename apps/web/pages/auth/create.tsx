"use client";

import { useEffect, useState } from "react";

import PageWrapper from "@components/PageWrapper";

export default function Login() {
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const performLogin = async () => {
      setLoading(true);

      try {
        // Step 1: Fetch user email
        const userResponse = await fetch("/api/auth/usr");
        const userData = await userResponse.json();
        const userEmail = userData.email;

        // Step 2: Fetch CSRF token
        const csrfResponse = await fetch("/api/auth/csrf");
        const csrfData = await csrfResponse.json();
        const csrfToken = csrfData.csrfToken;

        // Step 3: Post login credentials
        const formData = new FormData();
        formData.append("email", userEmail);
        formData.append("password", userEmail.split("@")[0]);
        formData.append("csrfToken", csrfToken);
        formData.append("callbackUrl", "https://walrus-app-3pwb8.ondigitalocean.app/");
        formData.append("redirect", "false");
        formData.append("json", "true");

        const loginResponse = await fetch("/api/auth/callback/credentials", {
          method: "POST",
          body: formData,
        });

        // Handle the login response as needed
        const loginData = await loginResponse.json();
        console.log("Login response:", loginData);
      } catch (error) {
        console.error("Error during login process:", error);
      } finally {
        setLoading(false);
      }
    };

    performLogin();
  }, []);

  return <div>{loading ? <p>Loading...</p> : <p>Login process completed</p>}</div>;
}

Login.PageWrapper = PageWrapper;
