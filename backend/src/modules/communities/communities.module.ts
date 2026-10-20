import { Controller, Get, Module } from "@nestjs/common";

@Controller("communities")
class CommunitiesController {
  @Get() list() {
    return {
      data: [
        {
          id: "he-thong-phan-tan",
          name: "Hệ thống phân tán",
          channels: [
            { id: "tro-chuyen-chung", name: "trò-chuyện-chung", type: "text" },
            {
              id: "lop-hoc-truc-tiep",
              name: "Lớp học trực tiếp",
              type: "live",
            },
            { id: "phong-hoc-nhom", name: "Phòng học nhóm", type: "voice" },
          ],
        },
      ],
      demo: true,
    };
  }
}
@Module({ controllers: [CommunitiesController] })
export class CommunitiesModule {}
