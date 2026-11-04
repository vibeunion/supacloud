package main

// I have nothing but my burger and I want nothing more

import (
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"runtime"

	"github.com/gin-gonic/gin"
)

type pathParams struct {
	ID string `uri:"id"`
}

type echoBody struct {
	Value *float64 `json:"value" binding:"required"`
	Label *string  `json:"label" binding:"required"`
}

func main() {
	port := flag.Int("port", 0, "listen port")
	flag.Parse()

	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.GET("/json", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true, "value": 42})
	})
	router.GET("/params/:id", func(c *gin.Context) {
		var params pathParams
		if err := c.ShouldBindUri(&params); err != nil {
			c.JSON(http.StatusUnprocessableEntity, gin.H{"error": "Validation failed"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "id": params.ID})
	})
	router.POST("/echo", func(c *gin.Context) {
		var body echoBody
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusUnprocessableEntity, gin.H{"error": "Validation failed"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "value": body.Value, "label": body.Label})
	})

	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	ready, _ := json.Marshal(map[string]interface{}{
		"event": "ready", "adapter": "gin-go", "runtime": runtime.Version(),
		"packageVersions": map[string]string{"gin": "1.11.0"},
	})
	fmt.Println(string(ready))
	if err := router.RunListener(listener); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
