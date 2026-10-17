import { Controller, Get, Module, Query } from "@nestjs/common";

@Controller("files")
class FilesController {
  @Get() list(@Query("q") query = "") {
    const files = [
      {
        id: "slide-05",
        name: "Slide — Hệ thống phân tán.pdf",
        kind: "document",
        size: 13002342,
      },
      {
        id: "record-04",
        name: "Buổi 04 — Kiến trúc hệ thống phân tán",
        kind: "recording",
        size: 448790528,
      },
    ];
    return {
      data: files.filter((file) =>
        file.name
          .toLocaleLowerCase("vi")
          .includes(query.toLocaleLowerCase("vi")),
      ),
      demo: true,
    };
  }
}
@Module({ controllers: [FilesController] })
export class FilesModule {}
